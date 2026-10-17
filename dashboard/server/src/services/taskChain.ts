import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
  ChainPairing, ChainStepRecord, ChainStepView, ChainStopKind, OfficeLaunch, RunQueueItem, RunTrigger, TaskChainRecord, TaskChainView,
  TaskLaunchCli, TaskStepResult, WorktreeTarget,
} from '../../../shared/types';
import type { NextStep } from './chainOffice';
import { TASK_CLIS, TASK_ROLES } from './officeLauncher';
import type { RunQueue } from './runQueue';

// Role chains (docs/start-task-redesign-spec.md D12): "Run until a human is needed".
// Each step is an ordinary Run queue item (runQueue.ts, D13: the cap, one step per task,
// the lease, validate -> enforce -> sync and the dashboard commit are unchanged). When a
// step has been verified, the chain asks scripts/decide-next-step.rb for the next role
// (chainOffice.ts; never decided here) and queues it, or stops and records why. It stops
// at every point that needs a person:
//
//   failed        the step failed, was stopped, hit its time limit, was lost, could not
//                 start, an agent committed, or the dashboard commit failed;
//   verification  an office script did not pass (unmet contract), or the task is in
//                 validation_failed;
//   gate          a completion gate keeps the task from done (sync exit 5, and
//                 decide-next-step.rb then names no next role with "Completion blocked");
//   authorization authorization-dispatch-check.rb reports a missing grant (or cannot
//                 judge) for the next role, whatever the authorization_dispatch mode;
//   blocked       status.yaml says blocked, blocked_on, waiting_for or waits_on;
//   changes       the reviewer asked for changes more than twice in this chain;
//   cap           the chain ran its step cap (default 6);
//   done          decide-next-step.rb says terminal (the reviewer approved; done): closing,
//                 merging, pushing and approving stay the operator's;
//   escalated     the next role is free-roam (never run in a chain), or the task is escalated;
//   cli / pairing the step's CLI cannot run (never swapped for another), or the reviewer
//                 would be the CLI that wrote the step under review;
//   no-next       decide-next-step.rb named no (usable) next role;
//   queue         the next step could not be queued (another Run of the task is queued);
//   operator      Stop (cancels the waiting step, stops the running one), or the step was
//                 cancelled in the queue.
//
// Merge, push and deploy have no signal of their own in decide-next-step.rb: an agent
// cannot do them (network off, the dashboard commits locally and never pushes), and the
// points that lead there are `done` and the deploy authorizations of pending gates, both
// stops above. Pairing: the writer CLI runs pm, dev, dev-2, debugger and devops, the
// reviewer CLI runs reviewer, and the two always differ. The chain lives in a file (one
// per office root, beside the launches) and advances on the queue's timer, so it
// survives a dashboard restart.

export const WRITER_ROLES = ['pm', 'dev', 'dev-2', 'debugger', 'devops'] as const;
/** The reviewer asking for changes more than this many times in one chain stops it. */
export const MAX_CHANGE_REQUESTS = 2;
export const MAX_CHAIN_CAP = 20;
const KEEP_ENDED = 50;

export class ChainRefusedError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}

export interface ChainDeps {
  queue: Pick<RunQueue, 'enqueue' | 'get' | 'cancel' | 'tick' | 'itemView'>;
  launches: { get(id: string): OfficeLaunch | null; stop(id: string): OfficeLaunch };
  /** The dashboard's verification of a step (stepGovernance.view). */
  result(launchId: string): TaskStepResult | undefined;
  /** scripts/decide-next-step.rb for the role that just ran. */
  decide(taskId: string, role: string): Promise<NextStep>;
  /** scripts/authorization-dispatch-check.rb for the role about to run. */
  authorize(taskId: string, role: string): Promise<{ ok: boolean; text: string }>;
  /** Why the task cannot take an unattended step now (status.yaml); null when it can. */
  hold(taskId: string): { kind: ChainStopKind; reason: string } | null;
  /** review_verdict of the task's reviewer output. */
  verdict(taskId: string): string | undefined;
  /** The D4 probe. */
  usable(cli: TaskLaunchCli): Promise<{ usable: boolean; reason?: string }>;
  /** The model the dashboard runs this CLI with (claude: Opus 5.5; codex: the pinned model). */
  model(cli: TaskLaunchCli): string | undefined;
  /** The CLI of the task's newest step before the chain, when that step was a writer's (its reviewer must differ). */
  previousWriter(taskId: string): TaskLaunchCli | undefined;
  defaults: { pairing: ChainPairing; cap: number };
  now?: () => Date;
  newId?: () => string;
}

export interface ChainStartInput {
  taskId: string;
  role: string;
  repos: WorktreeTarget[];
  note?: string;
  trigger: RunTrigger;
  pairing?: Partial<ChainPairing>;
  cap?: number;
}

interface ChainFile { version: 1; chains: TaskChainRecord[] }

const isRunning = (l: OfficeLaunch | null) => Boolean(l && ['running', 'stopping'].includes(l.status));
export const cliFor = (role: string, pairing: ChainPairing): TaskLaunchCli => (role === 'reviewer' ? pairing.reviewer : pairing.writer);

/** How a verified-or-not step ends the chain or lets it go on: ok, or the stop kind and why. */
export function stepOutcome(result: TaskStepResult): { ok: boolean; kind?: ChainStopKind; text: string; gateBlocked: boolean } {
  const gateBlocked = result.checks.some((c) => c.name === 'sync' && c.status === 'passed' && /^completion blocked/.test(c.detail));
  if (!result.protocol.ok) return { ok: false, kind: 'failed', text: result.protocol.text, gateBlocked };
  if (!result.lease.ok && !result.verified) return { ok: false, kind: 'failed', text: `the task lease was lost: ${result.lease.text}`, gateBlocked };
  const failed = result.checks.find((c) => c.status === 'failed');
  if (failed || !result.verified) return { ok: false, kind: 'verification', text: `verification failed at ${failed?.name ?? 'a check'}: ${failed?.detail ?? 'not every check passed'}`, gateBlocked };
  if (!result.agentCommits.ok) return { ok: false, kind: 'failed', text: `an agent committed in a step worktree: ${result.agentCommits.text}`, gateBlocked };
  const commitFailed = result.commits.find((c) => c.status === 'failed');
  if (commitFailed) return { ok: false, kind: 'failed', text: `the dashboard commit failed in ${commitFailed.repo}: ${commitFailed.text}`, gateBlocked };
  const committed = result.commits.filter((c) => c.status === 'committed' && c.sha);
  return { ok: true, text: committed.length ? `verified · committed ${committed.map((c) => `${c.repo} ${c.sha!.slice(0, 10)}`).join(', ')}` : 'verified · nothing to commit', gateBlocked };
}

export class TaskChains {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private serial: Promise<void> = Promise.resolve();

  constructor(readonly file: string, private readonly deps: ChainDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => `chain-${this.now().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 6)}`);
  }

  private read(): ChainFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ChainFile;
      return Array.isArray(parsed?.chains) ? parsed : { version: 1, chains: [] };
    } catch { return { version: 1, chains: [] }; }
  }

  private write(f: ChainFile) {
    const ended = f.chains.filter((c) => c.ended).sort((a, b) => b.ended!.at.localeCompare(a.ended!.at));
    const drop = new Set(ended.slice(KEEP_ENDED).map((c) => c.id));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, chains: f.chains.filter((c) => !drop.has(c.id)) }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** Read, change one chain, write, in one synchronous step; fn gets the live record (undefined: gone). */
  private mutate<T>(id: string, fn: (c: TaskChainRecord | undefined) => T): T {
    const f = this.read();
    const out = fn(f.chains.find((c) => c.id === id));
    this.write(f);
    return out;
  }

  get(id: string): TaskChainRecord | null { return this.read().chains.find((c) => c.id === id) ?? null; }

  /** The task's newest chain, running or ended. */
  latest(taskId: string): TaskChainRecord | null {
    return this.read().chains.filter((c) => c.taskId === taskId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
  }

  /** The task's running chain, if any. */
  active(taskId: string): TaskChainRecord | null {
    return this.read().chains.find((c) => c.taskId === taskId && !c.ended) ?? null;
  }

  /** Every running chain, oldest first. */
  running(): TaskChainView[] {
    return this.read().chains.filter((c) => !c.ended).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map((c) => this.toView(c));
  }

  view(id: string): TaskChainView | null {
    const c = this.get(id);
    return c ? this.toView(c) : null;
  }

  private stepView(s: ChainStepRecord): ChainStepView {
    const base: ChainStepView = { ...s, status: 'queued', commits: [] };
    let launchId = s.launchId;
    if (!launchId) {
      const item = this.deps.queue.itemView(s.itemId);
      if (!item) return { ...base, status: 'not started', waitingFor: 'its queue item is no longer on record' };
      if (item.state === 'waiting') return { ...base, status: 'queued', ...(item.waitingFor ? { waitingFor: item.waitingFor } : {}) };
      if (item.state === 'starting') return { ...base, status: 'starting' };
      if (item.state !== 'started' || !item.launchId) return { ...base, status: 'not started', waitingFor: `${item.state}${item.reason ? `: ${item.reason}` : ''}` };
      launchId = item.launchId;
    }
    const launch = this.deps.launches.get(launchId);
    const times = { ...(launch?.startedAt ? { startedAt: launch.startedAt } : {}), ...(launch?.finishedAt ? { finishedAt: launch.finishedAt } : {}) };
    if (isRunning(launch)) return { ...base, ...times, launchId, status: 'running' };
    const result = this.deps.result(launchId);
    // Launch records are pruned (10 per task): an old step keeps what the chain recorded of it.
    if (!result && !launch && s.outcome) return { ...base, launchId, status: s.outcome.ok ? 'verified' : 'failed', verification: s.outcome.text };
    if (!result || result.state === 'verifying') return { ...base, ...times, launchId, status: launch || result ? 'verifying' : 'failed', ...(launch || result ? {} : { verification: 'the launch is no longer on record' }) };
    const outcome = stepOutcome(result);
    return {
      ...base, ...times, launchId, status: outcome.ok ? 'verified' : 'failed', verification: outcome.text,
      ...(result.finishedAt ? { finishedAt: result.finishedAt } : {}),
      commits: result.commits.filter((c) => c.status === 'committed' && c.sha).map((c) => ({ repo: c.repo, sha: c.sha!, branch: c.branch })),
    };
  }

  private toView(c: TaskChainRecord): TaskChainView {
    return { ...c, active: !c.ended, steps: c.steps.map((s) => this.stepView(s)) };
  }

  /** The CLI that wrote the step a reviewer would review: the chain's last writer step, else the task's step before the chain. */
  private writerCli(c: Pick<TaskChainRecord, 'taskId' | 'steps'>): TaskLaunchCli | undefined {
    const last = [...c.steps].reverse().find((s) => s.role !== 'reviewer');
    return last ? last.cli : this.deps.previousWriter(c.taskId);
  }

  /** Whether `role` may run next as an unattended step, and on which CLI; else why the chain must stop. */
  private async preflight(taskId: string, role: string, pairing: ChainPairing, writer: TaskLaunchCli | undefined): Promise<{ cli: TaskLaunchCli } | { stop: { kind: ChainStopKind; reason: string } }> {
    const hold = this.deps.hold(taskId);
    if (hold) return { stop: hold };
    if (role === 'free-roam') return { stop: { kind: 'escalated', reason: 'free-roam is the escalation role: a chain never runs it, a person decides (Run it on its own if that is the call)' } };
    const cli = cliFor(role, pairing);
    if (role === 'reviewer' && writer === cli) {
      return { stop: { kind: 'pairing', reason: `the reviewer would run on ${cli}, the CLI that wrote the step under review; a chain's reviewer is always a different CLI (swap the pairing)` } };
    }
    const auth = await this.deps.authorize(taskId, role);
    if (!auth.ok) return { stop: { kind: 'authorization', reason: auth.text } };
    const usable = await this.deps.usable(cli);
    if (!usable.usable) return { stop: { kind: 'cli', reason: `${cli} cannot run the ${role} step: ${usable.reason ?? 'unusable'}; the chain does not swap in another CLI` } };
    return { cli };
  }

  private enqueueStep(c: Pick<TaskChainRecord, 'id' | 'taskId' | 'repos'>, n: number, role: string, cli: TaskLaunchCli, trigger: RunTrigger, note?: string): RunQueueItem {
    return this.deps.queue.enqueue({
      kind: 'task', key: c.taskId, label: `${c.taskId} ${role} (chain step ${n})`, trigger, chain: { id: c.id, step: n },
      step: { role, cli, repos: c.repos, ...(note ? { note } : {}) },
    });
  }

  /**
   * Starts a chain at `role`: checks it may run (refused with the reason when not),
   * queues step 1 with the trigger and advances the queue, like a single Run.
   */
  async start(input: ChainStartInput): Promise<{ chain: TaskChainView; item: RunQueueItem }> {
    const pairing: ChainPairing = { writer: input.pairing?.writer ?? this.deps.defaults.pairing.writer, reviewer: input.pairing?.reviewer ?? this.deps.defaults.pairing.reviewer };
    for (const cli of [pairing.writer, pairing.reviewer]) {
      if (!(TASK_CLIS as readonly string[]).includes(cli)) throw new ChainRefusedError(`A chain's CLIs must be among ${TASK_CLIS.join(', ')}.`, 400);
    }
    if (pairing.writer === pairing.reviewer) throw new ChainRefusedError(`The reviewer must be a different CLI from the writer (both are ${pairing.writer}).`, 400);
    const cap = input.cap ?? this.deps.defaults.cap;
    if (!Number.isInteger(cap) || cap < 1 || cap > MAX_CHAIN_CAP) throw new ChainRefusedError(`The step cap must be a whole number from 1 to ${MAX_CHAIN_CAP}.`, 400);
    if (!(TASK_ROLES as readonly string[]).includes(input.role)) throw new ChainRefusedError(`Role must be one of ${TASK_ROLES.join(', ')}.`, 400);
    const running = this.active(input.taskId);
    if (running) throw new ChainRefusedError(`A chain is already running on ${input.taskId} (${running.id}, step ${running.steps.length}); stop it first.`);
    const pre = await this.preflight(input.taskId, input.role, pairing, this.deps.previousWriter(input.taskId));
    if ('stop' in pre) throw new ChainRefusedError(`The chain cannot start: ${pre.stop.reason}.`);
    const id = this.newId();
    const record: TaskChainRecord = {
      id, taskId: input.taskId, startedAt: this.now().toISOString(), pairing, cap, repos: input.repos, ...(input.note ? { note: input.note } : {}), steps: [],
    };
    const item = this.enqueueStep(record, 1, input.role, pre.cli, input.trigger, input.note);
    record.steps.push({ n: 1, role: input.role, cli: pre.cli, ...(this.deps.model(pre.cli) ? { model: this.deps.model(pre.cli) } : {}), itemId: item.id });
    const f = this.read();
    f.chains.push(record);
    this.write(f);
    await this.deps.queue.tick();
    await this.advance(id);
    return { chain: this.view(id)!, item: this.deps.queue.itemView(item.id) ?? item };
  }

  /** Advance every running chain once (serialized), and finish a Stop that came while its step was starting. */
  tick(): Promise<void> {
    const run = this.serial.then(async () => {
      for (const c of this.read().chains) {
        if (!c.ended) await this.advance(c.id);
        else if (c.ended.kind === 'operator') this.stopLateStart(c);
      }
    });
    this.serial = run.catch(() => undefined);
    return run;
  }

  /** A step that was starting when the operator stopped the chain: stop its launch once it exists. */
  private stopLateStart(c: TaskChainRecord) {
    const step = c.steps[c.steps.length - 1];
    if (!step || step.launchId) return;
    const item = this.deps.queue.get(step.itemId);
    if (item?.state !== 'started' || !item.launchId) return;
    const launchId = item.launchId;
    this.mutate(c.id, (live) => { const s = live?.steps.find((x) => x.n === step.n); if (s) s.launchId = launchId; });
    if (isRunning(this.deps.launches.get(launchId))) { try { this.deps.launches.stop(launchId); } catch { /* already ended */ } }
  }

  private end(id: string, kind: ChainStopKind, reason: string) {
    this.mutate(id, (c) => { if (c && !c.ended) c.ended = { at: this.now().toISOString(), kind, reason }; });
  }

  private patchStep(id: string, n: number, patch: Partial<ChainStepRecord>) {
    this.mutate(id, (c) => { const s = c?.steps.find((x) => x.n === n); if (s && !c!.ended) Object.assign(s, patch); });
  }

  /** One step forward: follow the queued step, judge the ended one, then queue the next role or stop. */
  private async advance(id: string): Promise<void> {
    const c = this.get(id);
    if (!c || c.ended) return;
    const step = c.steps[c.steps.length - 1];
    const what = `step ${step.n} (${step.role} with ${step.cli})`;
    if (!step.launchId) {
      const item = this.deps.queue.get(step.itemId);
      if (!item) return this.end(id, 'failed', `${what}: its queue item is no longer on record`);
      if (item.state === 'waiting' || item.state === 'starting') return;
      if (item.state === 'cancelled') return this.end(id, 'operator', `${what} was cancelled in the queue before it started`);
      if (item.state !== 'started' || !item.launchId) return this.end(id, 'failed', `${what} could not start: ${item.reason ?? item.state}`);
      step.launchId = item.launchId;
      this.patchStep(id, step.n, { launchId: item.launchId });
    }
    const launch = this.deps.launches.get(step.launchId);
    if (isRunning(launch)) return;
    const result = this.deps.result(step.launchId);
    if (!result) return launch ? undefined : this.end(id, 'failed', `${what}: its launch and verification are no longer on record`);
    if (result.state === 'verifying') return;

    const outcome = stepOutcome(result);
    step.outcome = { ok: outcome.ok, text: outcome.text };
    this.patchStep(id, step.n, { outcome: step.outcome });
    if (!outcome.ok) return this.end(id, outcome.kind!, `${what} ${outcome.text}`);
    if (step.role === 'reviewer') {
      step.verdict = this.deps.verdict(c.taskId);
      this.patchStep(id, step.n, { ...(step.verdict ? { verdict: step.verdict } : {}) });
    }
    const changes = c.steps.filter((s) => s.role === 'reviewer' && s.verdict === 'changes_requested').length;
    if (changes > MAX_CHANGE_REQUESTS) {
      return this.end(id, 'changes', `the reviewer asked for changes ${changes} times in this chain (more than ${MAX_CHANGE_REQUESTS}): a person decides how to go on`);
    }

    const decision = await this.deps.decide(c.taskId, step.role);
    this.patchStep(id, step.n, { decision: { next: decision.next, terminal: decision.terminal, ...(decision.note ? { note: decision.note } : {}) } });
    if (decision.error) return this.end(id, 'no-next', decision.error);
    if (decision.terminal) {
      return this.end(id, 'done', `decide-next-step.rb: done after ${what}${step.verdict === 'approved' ? ', the reviewer approved' : ''}; closing the task, merging, pushing and approving are yours`);
    }
    const next = decision.next;
    if (!next) {
      if (outcome.gateBlocked || /completion blocked/i.test(decision.note ?? '')) {
        return this.end(id, 'gate', `a completion gate needs a person before the task can be done: ${decision.note ?? 'see the task\'s completion gates'}`);
      }
      return this.end(id, 'no-next', `decide-next-step.rb named no next role after ${what}${decision.note ? ` (${decision.note})` : ''}`);
    }
    if (next === 'free-roam') return this.end(id, 'escalated', `decide-next-step.rb routes to free-roam after ${what}: an escalation, a person decides`);
    if (!(TASK_ROLES as readonly string[]).includes(next)) return this.end(id, 'no-next', `decide-next-step.rb named "${next}" after ${what}, which is not a role the dashboard runs`);
    if (c.steps.length >= c.cap) return this.end(id, 'cap', `the chain ran its step cap (${c.steps.length} of ${c.cap}); the next step would be ${next}`);

    const pre = await this.preflight(c.taskId, next, c.pairing, this.writerCli(c));
    if ('stop' in pre) return this.end(id, pre.stop.kind, `before step ${step.n + 1} (${next}): ${pre.stop.reason}`);
    if (this.get(id)?.ended) return;
    let item: RunQueueItem;
    try { item = this.enqueueStep(c, step.n + 1, next, pre.cli, { kind: 'now' }); }
    catch (err) { return this.end(id, 'queue', `step ${step.n + 1} (${next}) could not be queued: ${err instanceof Error ? err.message : String(err)}`); }
    const added = this.mutate(id, (live) => {
      if (!live || live.ended) return false;
      live.steps.push({ n: step.n + 1, role: next, cli: pre.cli, ...(this.deps.model(pre.cli) ? { model: this.deps.model(pre.cli) } : {}), itemId: item.id });
      return true;
    });
    if (!added) { try { this.deps.queue.cancel(item.id); } catch { /* already starting */ } return; }
    await this.deps.queue.tick();
    return this.advance(id);
  }

  /** Stop: ends the chain, cancels its waiting step and stops its running one. */
  stop(taskId: string): TaskChainView | null {
    const c = this.active(taskId);
    if (!c) { const last = this.latest(taskId); return last ? this.toView(last) : null; }
    const step = c.steps[c.steps.length - 1];
    let launchId = step?.launchId;
    if (step && !launchId) {
      const item = this.deps.queue.get(step.itemId);
      if (item?.state === 'waiting') { try { this.deps.queue.cancel(item.id); } catch { /* started meanwhile */ } }
      const after = this.deps.queue.get(step.itemId);
      if (after?.state === 'started' && after.launchId) { launchId = after.launchId; this.patchStep(c.id, step.n, { launchId }); }
    }
    this.end(c.id, 'operator', `stopped by the operator at step ${step?.n ?? 0}${step ? ` (${step.role})` : ''}`);
    if (launchId && isRunning(this.deps.launches.get(launchId))) { try { this.deps.launches.stop(launchId); } catch { /* already ended */ } }
    return this.view(c.id);
  }
}

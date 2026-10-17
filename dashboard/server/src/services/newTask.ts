import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type {
  NewTaskClaimAttempt, NewTaskGates, NewTaskPreset, NewTaskRecord, NewTaskState, NewTaskView, OfficeLaunch,
  RunQueueItem, TaskLaunchCli, TaskStepResult,
} from '../../../shared/types';
import { PREFIX_PATTERN, RESERVED_PREFIXES } from './identity';
import type { ScriptResult } from './officeScripts';
import { stepOutcome } from './taskChain';

// New task from the dashboard (docs/start-task-redesign-spec.md D11):
//
//   1. the operator types a title and a request, picks a prefix and the gate decision
//      (presets from tasks/templates/gate-presets.yaml, or no gates with a reason);
//   2. the dashboard claims the id with scripts/open-task.rb in the office checkout it
//      runs in (config.aiOfficeRoot, the main checkout, where every run is visible). The
//      id is max+1 for the prefix over runs/ and tasks/, exactly run-agent.sh intake's
//      rule (nextTaskId). Claims are serialized inside the server; open-task.rb's exit 4
//      (the directory exists: another lane claimed that id meanwhile) retries with the
//      next id, a bounded number of times; exits 1/2/3/5 are refused with the script's
//      message. open-task.rb is the only writer of the new status.yaml (D6);
//   3. a pm step is queued like any Run (lease, verification), in runs-only mode: no
//      worktree, the step works in runs/<TASK> (launch.ts, taskPrompt.newTaskPmPrompt);
//   4. it stops there: the operator reads task.md and confirms before any chain starts
//      (launch.ts refuses a chain on a task in this list until it is confirmed or closed).
//
// The records (one JSON file per office root, beside the launches) are the dashboard's
// own: what it opened, its pm steps, and the operator's confirm or close.

/** What a namespace may be for a new task: open-task.rb's (task-namespace.rb) rules plus the dashboard identity's reserved set. */
export function allowedPrefixes(registry: Record<string, string>, effective: string | null): { allowed: string[]; default: string | null; note?: string } {
  const usable = (p: string) => PREFIX_PATTERN.test(p) && !RESERVED_PREFIXES.has(p);
  const mine = effective && usable(effective) ? effective : null;
  const registered = Object.entries(registry).filter(([p, owner]) => usable(p) && owner.trim()).map(([p]) => p).sort();
  if (!registered.length) {
    // Solo / legacy: no registry, so open-task.rb takes any valid prefix; offer the configured one, else the TASK-NNN pool.
    return mine ? { allowed: [mine], default: mine } : { allowed: [''], default: '', note: 'No prefix is configured: ids are TASK-NNN. Set your name in the dashboard to get one.' };
  }
  const allowed = mine && registered.includes(mine) ? [mine, ...registered.filter((p) => p !== mine)] : registered;
  if (mine && registered.includes(mine)) return { allowed, default: mine };
  return { allowed, default: null, note: effective ? `Your dashboard prefix ${effective} is not registered in office.team.yaml (or is reserved): pick one.` : 'No dashboard prefix is set: pick one, or set your name first.' };
}

/** Lists a directory's entry names; [] when it does not exist. */
export type DirLister = (dir: string) => string[];
const listDir: DirLister = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

/**
 * The next id for a prefix, run-agent.sh intake's rule exactly (show_intake_preview):
 * every entry of runs/ and tasks/ that is the whole id TASK-<PREFIX>-<digits> (TASK-<digits>
 * with no prefix), the largest number + 1, at least three digits. Anything else (another
 * prefix, a suffix, a non-digit) is ignored.
 */
export function nextTaskId(officeRoot: string, prefix: string, list: DirLister = listDir): string {
  const stem = prefix ? `TASK-${prefix}` : 'TASK';
  // The stem is TASK or TASK-<A-Z0-9…>: nothing in it needs escaping.
  const pattern = new RegExp(`^${stem}-(\\d+)$`);
  const numbers = [path.join(officeRoot, 'runs'), path.join(officeRoot, 'tasks')]
    .flatMap((dir) => list(dir)).map((name) => pattern.exec(name)?.[1]).filter((n): n is string => n !== undefined).map((n) => parseInt(n, 10));
  return formatId(stem, Math.max(0, ...numbers) + 1);
}

const formatId = (stem: string, n: number) => `${stem}-${String(n).padStart(3, '0')}`;
const idNumber = (id: string) => parseInt(/-(\d+)$/.exec(id)?.[1] ?? '0', 10);

/** tasks/templates/gate-presets.yaml as the form offers it: each preset with its gate names (open-task.rb validates them for real). */
export function readPresets(officeRoot: string): { presets: NewTaskPreset[]; error?: string } {
  const file = path.join(officeRoot, 'tasks', 'templates', 'gate-presets.yaml');
  try {
    const data = yaml.load(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { presets: [], error: `${file} is not a map of presets` };
    return {
      presets: Object.entries(data as Record<string, unknown>).map(([name, gates]) => ({
        name, gates: Array.isArray(gates) ? gates.map((g) => String((g as { name?: unknown })?.name ?? '?')) : [],
      })),
    };
  } catch (err) { return { presets: [], error: `cannot read ${file}: ${(err as Error).message}` }; }
}

export interface NewTaskInput { title: string; request: string; prefix: string; gates: NewTaskGates }

const TITLE_MAX = 120;
const REQUEST_MAX = 4000;
const REASON_MAX = 300;

/** The New task form's request, or why it is not usable (400). Presets XOR a no-gates reason, like open-task.rb. */
export function parseNewTask(body: unknown, allowed: { prefixes: string[]; presets: string[] }): NewTaskInput | { error: string } {
  const { title, request, prefix, presets, noGatesReason } = (body ?? {}) as Record<string, unknown>;
  if (typeof title !== 'string' || !title.trim()) return { error: 'Title is required.' };
  if (title.trim().length > TITLE_MAX || /[\r\n]/.test(title)) return { error: `Title must be one line of at most ${TITLE_MAX} characters.` };
  if (typeof request !== 'string' || !request.trim()) return { error: 'Describe the request: the pm step writes task.md from it.' };
  if (request.length > REQUEST_MAX) return { error: `The request must be at most ${REQUEST_MAX.toLocaleString('en-US')} characters.` };
  if (typeof prefix !== 'string') return { error: 'Pick a prefix.' };
  const p = prefix.trim().toUpperCase();
  if (!allowed.prefixes.includes(p)) {
    return { error: RESERVED_PREFIXES.has(p) ? `Prefix ${p} is reserved.` : `Prefix ${p || '(none)'} is not one you may open a task under here (${allowed.prefixes.map((x) => x || '(none)').join(', ')}).` };
  }
  const hasPresets = Array.isArray(presets) && presets.length > 0;
  const hasReason = noGatesReason !== undefined && noGatesReason !== null && noGatesReason !== '';
  if (hasPresets && hasReason) return { error: 'Choose gate presets or no gates, not both.' };
  if (hasPresets) {
    const names = (presets as unknown[]).map((x) => String(x).trim());
    const unknown = names.filter((n) => !allowed.presets.includes(n));
    if (unknown.length) return { error: `Unknown gate preset: ${unknown.join(', ')} (presets: ${allowed.presets.join(', ')}).` };
    if (new Set(names).size !== names.length) return { error: 'A preset is listed twice.' };
    return { title: title.trim(), request: request.trim(), prefix: p, gates: { presets: names } };
  }
  if (typeof noGatesReason !== 'string' || !noGatesReason.trim()) return { error: 'Choose the completion gates: a preset, or no gates with the reason.' };
  if (noGatesReason.trim().length > REASON_MAX || /[\r\n]/.test(noGatesReason)) return { error: `The no-gates reason must be one line of at most ${REASON_MAX} characters.` };
  return { title: title.trim(), request: request.trim(), prefix: p, gates: { none: noGatesReason.trim() } };
}

/** open-task.rb's argv after the script: the id, title, the request as task.md's placeholder, pm assigned, and the gate decision. */
export function openTaskArgs(taskId: string, input: NewTaskInput): string[] {
  return [taskId, '--title', input.title, '--description', input.request, '--agent', 'pm', '--actor', 'pm',
    ...('presets' in input.gates ? input.gates.presets.flatMap((p) => ['--preset', p]) : ['--no-gates', input.gates.none])];
}

export class NewTaskError extends Error {
  readonly status: number;
  readonly attempts: NewTaskClaimAttempt[];
  constructor(message: string, status: number, attempts: NewTaskClaimAttempt[] = []) { super(message); this.status = status; this.attempts = attempts; }
}

/** Runs scripts/open-task.rb with these arguments and environment from the office root. */
export type OpenTaskRunner = (args: string[], env: Record<string, string>) => Promise<ScriptResult>;

/** open-task.rb exits other than 0 and 4 (scripts/open-task.rb header): the HTTP status and what it means. */
const EXIT_MEANING: Record<number, { status: number; what: string }> = {
  1: { status: 403, what: 'the namespace was refused' },
  2: { status: 400, what: 'open-task.rb refused the arguments' },
  3: { status: 500, what: 'the gate presets file is unreadable or malformed' },
  5: { status: 500, what: 'a write failed and the task directory was removed' },
};

const message = (r: ScriptResult) => (r.stderr.trim() || r.stdout.trim()).split('\n').filter(Boolean).slice(-4).join(' ');

/**
 * Claims new task ids with open-task.rb, one claim at a time in this server. Other lanes
 * claim in the same checkout concurrently: when open-task.rb finds the directory exists
 * (exit 4) the next id is tried, at most maxAttempts ids in all.
 */
export class TaskIdClaimer {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: { officeRoot: string; run: OpenTaskRunner; list?: DirLister; maxAttempts?: number }) {}

  claim(input: NewTaskInput): Promise<{ taskId: string; attempts: NewTaskClaimAttempt[]; output: string }> {
    const run = this.chain.then(() => this.doClaim(input));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doClaim(input: NewTaskInput) {
    const max = this.options.maxAttempts ?? 5;
    const attempts: NewTaskClaimAttempt[] = [];
    let last: string | null = null;
    for (let i = 0; i < max; i += 1) {
      let taskId = nextTaskId(this.options.officeRoot, input.prefix, this.options.list);
      // The id that just lost is on disk now, so the listing moves past it; never try it (or a lower one) again.
      if (last && idNumber(taskId) <= idNumber(last)) taskId = formatId(input.prefix ? `TASK-${input.prefix}` : 'TASK', idNumber(last) + 1);
      const r = await this.options.run(openTaskArgs(taskId, input), input.prefix ? { OFFICE_TASK_PREFIX: input.prefix } : {});
      attempts.push({ taskId, exitCode: r.code, message: message(r) });
      if (r.code === 0) return { taskId, attempts, output: r.stdout.trim() };
      if (r.code !== 4) {
        const meaning = EXIT_MEANING[r.code] ?? { status: 500, what: `open-task.rb exited ${r.code}` };
        throw new NewTaskError(`Could not open ${taskId}: ${meaning.what} (open-task.rb exit ${r.code}): ${message(r) || 'no message'}`, meaning.status, attempts);
      }
      last = taskId;
    }
    throw new NewTaskError(`Could not claim a ${input.prefix ? `TASK-${input.prefix}` : 'TASK'} id: ${max} ids in a row were taken while claiming (${attempts.map((a) => a.taskId).join(', ')}); try again.`, 409, attempts);
  }
}

export interface NewTaskDeps {
  queue: { get(id: string): RunQueueItem | undefined; itemView(id: string): RunQueueItem | undefined };
  launches: { get(id: string): OfficeLaunch | null };
  result(launchId: string): TaskStepResult | undefined;
  now?: () => Date;
}

interface NewTaskFile { version: 1; tasks: NewTaskRecord[] }

const KEEP = 50;
const isRunning = (l: OfficeLaunch | null) => Boolean(l && ['running', 'stopping'].includes(l.status));

/** The pm step's status from its queue item, launch and verification (the chain timeline's rules). */
export function pmStepStatus(record: NewTaskRecord, deps: NewTaskDeps): NewTaskView['pm'] & { final?: { ok: boolean; text: string } } {
  if (!record.itemId) return { status: 'not started', text: record.queueError ?? 'the pm step was not queued' };
  const kept = record.pmOutcome?.itemId === record.itemId ? record.pmOutcome : undefined;
  const item = deps.queue.itemView(record.itemId);
  if (!item) return kept ? { status: kept.ok ? 'verified' : 'failed', text: kept.text, ...(kept.launchId ? { launchId: kept.launchId } : {}) } : { status: 'not started', text: 'its queue item is no longer on record' };
  if (item.state === 'waiting') return { status: 'queued', text: item.waitingFor ? `waiting for ${item.waitingFor}` : 'queued' };
  if (item.state === 'starting') return { status: 'starting', text: 'starting' };
  if (item.state !== 'started' || !item.launchId) {
    const text = `could not start (${item.state}${item.reason ? `: ${item.reason}` : ''})`;
    return { status: 'not started', text, final: { ok: false, text } };
  }
  const launchId = item.launchId;
  const launch = deps.launches.get(launchId);
  if (isRunning(launch)) return { status: 'running', text: 'running', launchId };
  const result = deps.result(launchId);
  if (!result && !launch && kept) return { status: kept.ok ? 'verified' : 'failed', text: kept.text, launchId };
  if (!result || result.state === 'verifying') {
    return launch || result ? { status: 'verifying', text: 'verifying with the office scripts', launchId }
      : { status: 'failed', text: 'the launch is no longer on record', launchId, final: { ok: false, text: 'the launch is no longer on record' } };
  }
  const outcome = stepOutcome(result);
  return { status: outcome.ok ? 'verified' : 'failed', text: outcome.text, launchId, final: { ok: outcome.ok, text: outcome.text } };
}

export function newTaskState(record: NewTaskRecord, pm: NewTaskView['pm']): NewTaskState {
  if (record.closedAt) return 'closed';
  if (record.confirmedAt) return 'confirmed';
  if (pm.status === 'verified') return 'review';
  if (pm.status === 'failed' || pm.status === 'not started') return 'pm-failed';
  return 'pm';
}

export class NewTaskRefusedError extends Error {
  readonly status: number;
  constructor(msg: string, status = 409) { super(msg); this.status = status; }
}

/** The tasks the dashboard opened, with their pm steps and the operator's confirm or close. */
export class NewTasks {
  private readonly now: () => Date;

  constructor(readonly file: string, private readonly deps: NewTaskDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private read(): NewTaskFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as NewTaskFile;
      return Array.isArray(parsed?.tasks) ? parsed : { version: 1, tasks: [] };
    } catch { return { version: 1, tasks: [] }; }
  }

  private mutate<T>(fn: (f: NewTaskFile) => T): T {
    const f = this.read();
    const out = fn(f);
    f.tasks = f.tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, KEEP);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(f, null, 2));
    fs.renameSync(tmp, this.file);
    return out;
  }

  get(taskId: string): NewTaskRecord | undefined { return this.read().tasks.find((t) => t.taskId === taskId); }

  add(input: NewTaskInput & { taskId: string; cli: TaskLaunchCli; attempts: NewTaskClaimAttempt[] }): NewTaskRecord {
    const record: NewTaskRecord = {
      taskId: input.taskId, title: input.title, request: input.request, prefix: input.prefix, gates: input.gates,
      createdAt: this.now().toISOString(), cli: input.cli, itemIds: [], attempts: input.attempts,
    };
    this.mutate((f) => { f.tasks = [record, ...f.tasks.filter((t) => t.taskId !== input.taskId)]; });
    return record;
  }

  /** The pm step was queued (a Redo replaces the newest one), or could not be (queueError). */
  setPmStep(taskId: string, step: { itemId: string } | { error: string }): NewTaskRecord {
    return this.mutate((f) => {
      const t = f.tasks.find((x) => x.taskId === taskId);
      if (!t) throw new NewTaskRefusedError(`${taskId} was not opened from New task.`, 404);
      if ('itemId' in step) { t.itemId = step.itemId; t.itemIds = [...t.itemIds, step.itemId]; delete t.queueError; } else { delete t.itemId; t.queueError = step.error; }
      delete t.pmOutcome;
      return { ...t };
    });
  }

  /** The record with its pm step's state; a final pm outcome is kept on the record. */
  view(taskId: string): NewTaskView | null {
    const record = this.get(taskId);
    if (!record) return null;
    const { final, ...pm } = pmStepStatus(record, this.deps);
    if (final && record.itemId && (record.pmOutcome?.itemId !== record.itemId || record.pmOutcome.ok !== final.ok || record.pmOutcome.text !== final.text)) {
      const outcome = { itemId: record.itemId, ok: final.ok, text: final.text, ...(pm.launchId ? { launchId: pm.launchId } : {}) };
      this.mutate((f) => { const t = f.tasks.find((x) => x.taskId === taskId); if (t) t.pmOutcome = outcome; });
      record.pmOutcome = outcome;
    }
    return { ...record, pm, state: newTaskState(record, pm) };
  }

  /** Tasks that still need the operator here: the pm step running or failed, or task.md to review. Newest first. */
  open(): NewTaskView[] {
    return this.read().tasks.map((t) => this.view(t.taskId)).filter((v): v is NewTaskView => Boolean(v && ['pm', 'pm-failed', 'review'].includes(v.state)));
  }

  /** Why a chain may not start on the task yet (opened here, not confirmed or closed); null when it may. */
  chainHold(taskId: string): string | null {
    const t = this.get(taskId);
    if (!t || t.confirmedAt || t.closedAt) return null;
    return `${taskId} was opened from New task: review its task.md and press Confirm and start chain (Command › New task) before a chain starts.`;
  }

  /** The operator read task.md and confirms: only once the pm step is verified. */
  confirm(taskId: string): NewTaskView {
    const v = this.view(taskId);
    if (!v) throw new NewTaskRefusedError(`${taskId} was not opened from New task.`, 404);
    if (v.state === 'closed') throw new NewTaskRefusedError(`${taskId} was closed from New task.`);
    if (v.state !== 'review' && v.state !== 'confirmed') throw new NewTaskRefusedError(`${taskId}'s pm step is ${v.pm.status}${v.pm.text ? ` (${v.pm.text})` : ''}: confirm once it is verified and task.md is written.`);
    if (!v.confirmedAt) this.mutate((f) => { const t = f.tasks.find((x) => x.taskId === taskId); if (t) t.confirmedAt = this.now().toISOString(); });
    return this.view(taskId)!;
  }

  /** The operator closes it here (the task stays opened: abort it with the office tools if it should not go on). */
  close(taskId: string): NewTaskView {
    const v = this.view(taskId);
    if (!v) throw new NewTaskRefusedError(`${taskId} was not opened from New task.`, 404);
    if (v.state === 'pm') throw new NewTaskRefusedError(`${taskId}'s pm step is ${v.pm.status}: cancel it in the Run queue or stop it first.`);
    if (!v.closedAt) this.mutate((f) => { const t = f.tasks.find((x) => x.taskId === taskId); if (t) t.closedAt = this.now().toISOString(); });
    return this.view(taskId)!;
  }
}

/** How the task's gates were decided, in words (the pm prompt and the review). */
export const gatesLine = (gates: NewTaskGates) => ('presets' in gates ? `gate presets ${gates.presets.join(', ')}` : `no completion gates (${gates.none})`);

export interface NewTaskFlowDeps {
  claimer: Pick<TaskIdClaimer, 'claim'>;
  store: NewTasks;
  queue: {
    enqueue(input: { kind: 'task'; key: string; label: string; trigger: { kind: 'now' }; step: NonNullable<RunQueueItem['step']> }): RunQueueItem;
    tick(): Promise<void>;
    itemView(id: string): RunQueueItem | undefined;
  };
  launches: { get(id: string): OfficeLaunch | null };
  /** What the form may offer now: the prefixes (office.team.yaml, the dashboard identity) and the presets. */
  options(): Promise<{ prefixes: string[]; presets: string[] }>;
  /** The CLI the pm step runs on (the chain writer). */
  writer: TaskLaunchCli;
  /** The D4 probe. */
  usable(cli: TaskLaunchCli): Promise<{ usable: boolean; reason?: string }>;
}

const NOTE_MAX = 4000;

/**
 * New task end to end, up to the operator's review: validate, claim the id (open-task.rb),
 * record it, queue the runs-only pm step and advance the queue once. Nothing is claimed
 * when the request is not usable or the pm step's CLI cannot run; once claimed, a pm step
 * that cannot be queued leaves the task opened with the reason (pm-failed).
 */
export class NewTaskFlow {
  constructor(private readonly deps: NewTaskFlowDeps) {}

  private async usableWriter(): Promise<TaskLaunchCli> {
    const cli = this.deps.writer;
    if (cli === 'cursor-agent') throw new NewTaskError('The pm step runs on the chain writer CLI, which is cursor-agent here: a runs-only step needs claude or codex (DASHBOARD_CHAIN_WRITER_CLI).', 400);
    const u = await this.deps.usable(cli);
    if (!u.usable) throw new NewTaskError(`${cli} cannot run the pm step: ${u.reason ?? 'not usable'}. Nothing was claimed.`, 400);
    return cli;
  }

  async create(body: unknown): Promise<{ task: NewTaskView; attempts: NewTaskClaimAttempt[]; launch: OfficeLaunch | null }> {
    const input = parseNewTask(body, await this.deps.options());
    if ('error' in input) throw new NewTaskError(input.error, 400);
    const cli = await this.usableWriter();
    const { taskId, attempts } = await this.deps.claimer.claim(input);
    this.deps.store.add({ ...input, taskId, cli, attempts });
    const launch = await this.queuePm(taskId, cli);
    return { task: this.deps.store.view(taskId)!, attempts, launch };
  }

  /** Redo the pm step (a failed one, or a task.md the operator wants changed), with an optional note. */
  async redo(taskId: string, note: unknown): Promise<{ task: NewTaskView; launch: OfficeLaunch | null }> {
    const v = this.deps.store.view(taskId);
    if (!v) throw new NewTaskError(`${taskId} was not opened from New task.`, 404);
    if (v.state !== 'pm-failed' && v.state !== 'review') {
      throw new NewTaskError(`${taskId} is ${v.state === 'pm' ? `waiting on its pm step (${v.pm.status})` : v.state}: Redo pm is for a failed pm step or a task.md under review.`, 409);
    }
    if (note !== undefined && (typeof note !== 'string' || note.length > NOTE_MAX)) throw new NewTaskError(`The note must be text of at most ${NOTE_MAX.toLocaleString('en-US')} characters.`, 400);
    const cli = await this.usableWriter();
    const launch = await this.queuePm(taskId, cli, typeof note === 'string' && note.trim() ? note.trim() : undefined);
    return { task: this.deps.store.view(taskId)!, launch };
  }

  private async queuePm(taskId: string, cli: TaskLaunchCli, note?: string): Promise<OfficeLaunch | null> {
    let item: RunQueueItem;
    try {
      item = this.deps.queue.enqueue({ kind: 'task', key: taskId, label: `${taskId} pm`, trigger: { kind: 'now' },
        step: { role: 'pm', cli, repos: [], runsOnly: true, ...(note ? { note } : {}) } });
    } catch (err) {
      this.deps.store.setPmStep(taskId, { error: `the pm step could not be queued: ${(err as Error).message}` });
      return null;
    }
    this.deps.store.setPmStep(taskId, { itemId: item.id });
    await this.deps.queue.tick();
    const now = this.deps.queue.itemView(item.id);
    return now?.state === 'started' && now.launchId ? this.deps.launches.get(now.launchId) : null;
  }
}

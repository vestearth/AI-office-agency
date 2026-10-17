import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { OfficeLaunch, RunTermination, StepCheck, StepCommit, TaskLaunchCli, TaskStepResult } from '../../../shared/types';
import { ruby, run, tail } from './officeScripts';
import { LeaseRefusedError, TaskLease, type LeaseGrant } from './taskLease';
import { git } from './worktrees';

// The dashboard as the runtime adapter for one task step (docs/start-task-redesign-spec.md
// D5, D6, D8; docs/runtime-adapter-contract.md operations 4 and 5):
//
// begin       before the step: an office run record (scripts/record-run.rb; its run id
//             keys the lease and the evidence), the task's ownership lease
//             (taskLease.ts), the task-input-integrity snapshot run-agent.sh takes, the
//             role output's digest and a listing of runs/<TASK>.
// attach      after the worktrees exist: HEAD and branch of each, before the agent runs.
// finalize    after the step ends (any ending), once:
//             1. the CLI's protocol result (officeLauncher/streamProgress);
//             2. the lease is still ours (renew), else nothing below runs;
//             3. checks, stopping at the first failure: the role output is new, task
//                input integrity, validate-yaml.rb, enforce-output-contract.rb,
//                sync-status-from-output.rb. status.yaml is written only by those
//                scripts (enforce on a failure, sync on success);
//             4. agent-commit detection: a commit in a step worktree the dashboard did
//                not make (cursor-agent can commit) fails the step, and nothing is
//                committed on top;
//             5. verified and no agent commit: one local commit per worktree of its diff
//                on the task branch (never .cache/ or .cursor/, hooks off, never pushed),
//                and record-evidence.sh records each commit as artifact evidence under
//                the step's run id;
//             6. the run record's outcome, the lease released, what changed in runs/<TASK>
//                (the dashboard never commits runs: lanes do).
//
// Each step's record is a file next to its launch (<id>.step), progress saved as it
// goes, so a dashboard restart resumes or finalizes a step that ended while it was down
// (tick), and releases its lease. A lease the dashboard can no longer finalize (its
// files gone) lapses after the office's lease_seconds.

/** Never part of a dashboard commit: the step's Go cache and cursor-agent's sandbox policy (cliAdapter.prepareWorkspace). */
const NEVER_COMMIT = ['.cache', '.cursor'];
const CHECK_ORDER: StepCheck['name'][] = ['output', 'integrity', 'validate', 'enforce', 'sync'];
/** Conventional type per role when the output summary is not already a conventional subject. */
const ROLE_TYPE: Record<string, string> = { pm: 'docs', dev: 'feat', 'dev-2': 'feat', debugger: 'fix', devops: 'chore', reviewer: 'chore', 'free-roam': 'chore' };
const CONVENTIONAL = /^(feat|fix|docs|chore|refactor|test|perf|build|ci|style|revert)(\([^)]+\))?!?: \S/;

export interface StepWorktree { repo: string; path: string; branch: string; head?: string }

export interface StepRecord {
  launchId: string;
  taskId: string;
  role: string;
  cli: TaskLaunchCli;
  model?: string;
  runId: string;
  grant: LeaseGrant;
  startedAt: string;
  /** sha256 of runs/<TASK>/<role>-output.yaml when the step started; null when absent. */
  outputBefore: string | null;
  runsBefore: Record<string, string>;
  /** The task-input-integrity snapshot file; null when it could not be taken (begin fails then). */
  integrity: string | null;
  worktrees: StepWorktree[];
  /** Saved as finalize goes, so a restart resumes where it stopped. */
  progress?: { checks: StepCheck[]; commits: StepCommit[] };
  result?: TaskStepResult;
}

export interface CommitMessageInput { taskId: string; role: string; cli: TaskLaunchCli; model?: string; launchId: string; runId: string; summary: string }

/** The dashboard commit's message: a conventional subject (the output's summary, or the role's step) and provenance trailers. */
export function commitMessage(input: CommitMessageInput): { subject: string; body: string; trailers: string[] } {
  const first = input.summary.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const raw = CONVENTIONAL.test(first) ? first : `${ROLE_TYPE[input.role] ?? 'chore'}(${input.taskId.toLowerCase()}): ${first || `${input.role} step`}`;
  const subject = raw.length > 72 ? `${raw.slice(0, 71)}…` : raw;
  return {
    subject,
    body: `${input.role} step of ${input.taskId}, run with ${input.cli} from the AI Dev Office dashboard. The office scripts (validate-yaml.rb, enforce-output-contract.rb, sync-status-from-output.rb) passed on runs/${input.taskId}/${input.role}-output.yaml before this commit.`,
    trailers: [`Task: ${input.taskId}`, `Role: ${input.role}`, `CLI: ${input.cli}`, `Model: ${input.model ?? 'CLI default'}`, `Launch-Id: ${input.launchId}`, `Run-Id: ${input.runId}`],
  };
}

const sha256 = (file: string): string | null => {
  try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
};

/** Every file under runs/<TASK> (relative path -> content hash), without lock and temp files. */
function listing(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else if (e.isFile() && !/(^|\/)\.(ownership\.)?lock$|\.tmp\.\d+$/.test(child)) out[child] = sha256(path.join(dir, child)) ?? '';
    }
  };
  walk('');
  return out;
}

function changes(before: Record<string, string>, after: Record<string, string>): TaskStepResult['runsChanged'] {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return paths.flatMap((p): TaskStepResult['runsChanged'] => (!(p in before) ? [{ path: p, change: 'added' }]
    : !(p in after) ? [{ path: p, change: 'deleted' }]
      : before[p] !== after[p] ? [{ path: p, change: 'modified' }] : []));
}

/** Local date as `date +%F` prints it (run-agent.sh's TODAY). */
const today = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const lastLine = (s: string) => s.trim().split('\n').map((l) => l.trim()).filter(Boolean).slice(-1)[0] ?? '';

export interface LaunchLookup { get(id: string): OfficeLaunch | null }

export class StepGovernance {
  readonly officeRoot: string;
  private readonly dir: string;
  private readonly lease: TaskLease;
  private readonly now: () => Date;
  private readonly inFlight = new Map<string, Promise<TaskStepResult>>();
  /** Steps between begin and their spawn (or abort): tick must not take them for lost. */
  private readonly starting = new Set<string>();

  constructor(options: { officeRoot: string; dir: string; lease?: TaskLease; now?: () => Date }) {
    this.officeRoot = options.officeRoot;
    this.dir = options.dir;
    this.lease = options.lease ?? new TaskLease(options.officeRoot);
    this.now = options.now ?? (() => new Date());
  }

  private taskDir(taskId: string) { return path.join(this.officeRoot, 'runs', taskId); }
  private file(launchId: string) { return path.join(this.dir, `${launchId}.step`); }

  private load(launchId: string): StepRecord | null {
    try { return JSON.parse(fs.readFileSync(this.file(launchId), 'utf8')) as StepRecord; } catch { return null; }
  }

  private save(record: StepRecord) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file(record.launchId)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, this.file(record.launchId));
  }

  private records(): StepRecord[] {
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    return names.filter((n) => n.endsWith('.step')).flatMap((n) => { const r = this.load(n.slice(0, -'.step'.length)); return r ? [r] : []; });
  }

  private config(key: string, fallback: string) {
    return ruby(this.officeRoot, 'scripts/resolve-office-config.rb', ['get', this.officeRoot, key, fallback]).then((r) => (r.code === 0 && r.stdout.trim()) || fallback);
  }

  /** A step of this task is waiting for (or in) finalization: no other step may start. */
  pending(taskId: string): boolean {
    return this.records().some((r) => r.taskId === taskId && !r.result);
  }

  /** The step's result, `verifying` until finalize is done; undefined for a launch with no step record (the knowledge re-check, older launches). */
  view(launchId: string): TaskStepResult | undefined {
    const r = this.load(launchId);
    if (!r) return undefined;
    return r.result ?? this.partial(r);
  }

  private partial(r: StepRecord): TaskStepResult {
    return {
      state: 'verifying', launchId: r.launchId, runId: r.runId, role: r.role, cli: r.cli, ...(r.model ? { model: r.model } : {}),
      protocol: { ok: true, text: 'the step ended: verifying' }, lease: { ok: true, text: `held by ${r.runId}` },
      checks: r.progress?.checks ?? [], verified: false, agentCommits: { ok: true, text: 'not checked yet', found: [] }, commits: r.progress?.commits ?? [], runsChanged: [],
    };
  }

  /** Before the step: run record, lease, integrity snapshot, output digest, runs listing. Throws LeaseRefusedError (409) with the holder. */
  async begin(input: { launchId: string; taskId: string; role: string; cli: TaskLaunchCli; model?: string; prompt?: string }): Promise<StepRecord> {
    const taskDir = this.taskDir(input.taskId);
    if (!fs.existsSync(taskDir)) throw Object.assign(new Error(`No run directory for ${input.taskId}.`), { status: 404 });
    const held = this.lease.holder(taskDir);
    if (held?.live) {
      throw new LeaseRefusedError(`TASK ownership refused: ${input.taskId} is held by run ${held.runId} (agent=${held.agent ?? 'unknown'}, epoch=${held.epoch}, expires ${held.expiresAt}). Wait for that step to finish or its lease to lapse.`);
    }
    const started = await ruby(this.officeRoot, 'scripts/record-run.rb', ['start', taskDir, input.taskId, input.role,
      `client=dashboard-${input.cli}`, `model_requested=${input.model ?? ''}`, `harness_version=${await this.config('office.version', '')}`], { stdin: input.prompt ?? '' });
    const runId = started.stdout.trim();
    if (started.code !== 0 || !runId) throw Object.assign(new Error(`Could not record the run (record-run.rb exit ${started.code}): ${tail(started.stderr, 3)}`), { status: 500 });
    const finishRun = (pairs: string[]) => ruby(this.officeRoot, 'scripts/record-run.rb', ['finish', taskDir, runId, ...pairs]);

    let grant: LeaseGrant;
    try {
      grant = await this.lease.acquire(taskDir, input.taskId, { runId, agent: input.role, reason: `dashboard step ${input.launchId} (${input.cli})` });
    } catch (err) {
      await finishRun(['outcome.status=failed', 'outcome.exit_code=9']);
      throw err;
    }
    const integrity = path.join(this.dir, `${input.launchId}.integrity`);
    fs.mkdirSync(this.dir, { recursive: true });
    const snap = await ruby(this.officeRoot, 'scripts/task-input-integrity.rb', ['snapshot', taskDir, input.taskId, input.role, integrity, '--office-dir', this.officeRoot], { env: this.lease.fencedEnv(grant) });
    if (snap.code !== 0) {
      await finishRun(['outcome.status=failed', `outcome.exit_code=${snap.code}`]);
      await this.lease.release(grant, `dashboard step ${input.launchId}: integrity snapshot failed`);
      throw Object.assign(new Error(`Could not snapshot the task inputs (task-input-integrity.rb exit ${snap.code}): ${tail(snap.stderr || snap.stdout, 3)}`), { status: 500 });
    }
    const record: StepRecord = {
      launchId: input.launchId, taskId: input.taskId, role: input.role, cli: input.cli, ...(input.model ? { model: input.model } : {}), runId, grant,
      startedAt: this.now().toISOString(), outputBefore: sha256(path.join(taskDir, `${input.role}-output.yaml`)), runsBefore: listing(taskDir), integrity, worktrees: [],
    };
    this.save(record);
    this.starting.add(record.launchId);
    return record;
  }

  /**
   * After the worktrees exist and before the agent runs: each one's HEAD and branch
   * (agent-commit detection compares against these), and into the run record the primary
   * worktree's HEAD and the hash of the prompt (it names the worktrees, so it is built now).
   */
  async attachWorktrees(record: StepRecord, worktrees: StepWorktree[], prompt?: string): Promise<StepRecord> {
    record.worktrees = await Promise.all(worktrees.map(async (w) => ({ ...w, head: (await git(w.path, ['rev-parse', 'HEAD'])).trim() })));
    this.save(record);
    const pairs = [
      ...(record.worktrees[0]?.head ? [`repo_sha=${record.worktrees[0].head}`] : []),
      ...(prompt ? [`instruction_sha=sha256:${createHash('sha256').update(prompt).digest('hex')}`] : []),
    ];
    if (pairs.length) await ruby(this.officeRoot, 'scripts/record-run.rb', ['update', this.taskDir(record.taskId), record.runId, ...pairs]);
    return record;
  }

  /** The step's process was spawned: from now on its launch decides when it ended. */
  markStarted(record: StepRecord) { this.starting.delete(record.launchId); }

  /** What the step's detached wrapper runs to keep the lease while the CLI is alive. */
  heartbeat(record: StepRecord): { argv: string[]; intervalMs: number } | undefined {
    return record.grant.disabled ? undefined : { argv: this.lease.renewArgv(record.grant), intervalMs: record.grant.renewIntervalSeconds * 1000 };
  }

  /** The step never started (worktrees refused, the CLI did not spawn): release everything and record why. */
  async abort(record: StepRecord, reason: string): Promise<TaskStepResult> {
    this.starting.delete(record.launchId);
    return this.complete(record, {
      protocol: { ok: false, text: `the step did not start: ${reason}` }, checks: this.skippedChecks(record, 'the step did not start'),
      agentCommits: { ok: true, text: 'not checked: the step did not start', found: [] }, commits: this.skippedCommits(record, 'the step did not start'), exitCode: null,
    });
  }

  /** Finalizes every step that has ended (also the ones that ended while the dashboard was down). */
  async tick(launches: LaunchLookup): Promise<void> {
    for (const r of this.records().filter((x) => !x.result && !this.starting.has(x.launchId))) {
      const launch = launches.get(r.launchId);
      if (launch && ['running', 'stopping'].includes(launch.status)) continue;
      await this.finalize(launch ?? { id: r.launchId, status: 'lost' } as OfficeLaunch).catch((err) => console.warn(`finalizing step ${r.launchId} failed:`, err));
    }
  }

  /** Verifies and commits one ended step, once (a second call returns the stored result). */
  finalize(launch: OfficeLaunch): Promise<TaskStepResult> {
    const existing = this.inFlight.get(launch.id);
    if (existing) return existing;
    const work = this.doFinalize(launch).finally(() => this.inFlight.delete(launch.id));
    this.inFlight.set(launch.id, work);
    return work;
  }

  private skippedChecks(record: StepRecord, why: string): StepCheck[] {
    return CHECK_ORDER.map((name) => ({ name, command: this.commandFor(record, name), status: 'skipped' as const, detail: why }));
  }

  private skippedCommits(record: StepRecord, why: string): StepCommit[] {
    return record.worktrees.map((w) => ({ repo: w.repo, path: w.path, branch: w.branch, status: 'skipped' as const, text: why }));
  }

  private commandFor(record: StepRecord, name: StepCheck['name']): string {
    const t = record.taskId;
    const out = `runs/${t}/${record.role}-output.yaml`;
    switch (name) {
      case 'output': return `${out} written during the step`;
      case 'integrity': return `ruby scripts/task-input-integrity.rb verify runs/${t} ${t} ${record.role} <snapshot>`;
      case 'validate': return `ruby validate-yaml.rb ${t}`;
      case 'enforce': return `ruby scripts/enforce-output-contract.rb ${t} ${record.role}`;
      case 'sync': return `ruby scripts/sync-status-from-output.rb ${t} ${record.role} runs/${t}/status.yaml ${out} <today> <reviewer queue phase>`;
      default: return name;
    }
  }

  private async doFinalize(launch: OfficeLaunch): Promise<TaskStepResult> {
    const record = this.load(launch.id);
    if (!record) throw Object.assign(new Error(`No step record for launch ${launch.id}.`), { status: 404 });
    if (record.result) return record.result;

    const protocol = launch.status === 'succeeded' ? { ok: true, text: `exit 0 with the CLI's final result event` }
      : launch.status === 'stopped' ? { ok: false, text: 'stopped by the operator' }
        : launch.status === 'lost' ? { ok: false, text: 'lost: the process ended without an exit code (killed, or the machine restarted)' }
          : { ok: false, text: `failed: ${launch.failureReason ?? `exit code ${launch.exitCode ?? 'unknown'}`}` };
    const exitCode = typeof launch.exitCode === 'number' ? launch.exitCode : null;
    const termination = launch.termination ?? 'unknown';
    const agentCommits = await this.detectAgentCommits(record);

    if (!protocol.ok) {
      return this.complete(record, { protocol, checks: this.skippedChecks(record, `not run: the step ${launch.status === 'succeeded' ? 'ended' : 'did not succeed'} (${protocol.text})`),
        agentCommits, commits: this.skippedCommits(record, 'no commit: the step did not succeed; its changes stay uncommitted in the worktree'), exitCode, termination });
    }

    const renewed = await this.lease.renew(record.grant);
    if (!renewed.ok) {
      return this.complete(record, { protocol, leaseLost: renewed.message, checks: this.skippedChecks(record, 'not run: the task lease was lost (another run owns the task now)'),
        agentCommits, commits: this.skippedCommits(record, 'no commit: the task lease was lost; the changes stay uncommitted in the worktree'), exitCode, termination });
    }

    const checks = await this.runChecks(record);
    const verified = checks.every((c) => c.status === 'passed');
    let commits: StepCommit[];
    if (!verified) {
      const failed = checks.find((c) => c.status === 'failed');
      commits = this.skippedCommits(record, `no commit: verification failed at ${failed?.name ?? 'a check'}; the diff stays uncommitted in the worktree`);
    } else if (!agentCommits.ok) {
      commits = this.skippedCommits(record, 'no commit: an agent commit was found in a step worktree; the dashboard commits nothing on top and leaves the worktree as it is');
    } else {
      commits = await this.commitAll(record);
    }
    return this.complete(record, { protocol, checks, agentCommits, commits, exitCode, termination });
  }

  private async runChecks(record: StepRecord): Promise<StepCheck[]> {
    const taskDir = this.taskDir(record.taskId);
    const output = path.join(taskDir, `${record.role}-output.yaml`);
    const env = this.lease.fencedEnv(record.grant);
    const done = record.progress?.checks ?? [];
    const checks: StepCheck[] = [];
    const save = () => { record.progress = { checks: [...checks], commits: record.progress?.commits ?? [] }; this.save(record); };
    const fromScript = (name: StepCheck['name'], r: { code: number; stdout: string; stderr: string }, ok: boolean, detail?: string): StepCheck => ({
      name, command: this.commandFor(record, name), status: ok ? 'passed' : 'failed', exitCode: r.code,
      detail: detail ?? (lastLine(ok ? r.stdout || r.stderr : r.stderr || r.stdout) || `exit ${r.code}`),
      ...(ok ? {} : { output: tail(`${r.stdout}\n${r.stderr}`) }),
    });

    for (const name of CHECK_ORDER) {
      const previous = done.find((c) => c.name === name && c.status === 'passed');
      if (previous) { checks.push(previous); continue; }
      let check: StepCheck;
      switch (name) {
        case 'output': {
          const digest = sha256(output);
          check = { name, command: this.commandFor(record, name), ...(digest === null
            ? { status: 'failed', detail: `runs/${record.taskId}/${record.role}-output.yaml was not written` }
            : digest === record.outputBefore
              ? { status: 'failed', detail: `runs/${record.taskId}/${record.role}-output.yaml is unchanged since the step started: this step wrote no output` }
              : { status: 'passed', detail: `runs/${record.taskId}/${record.role}-output.yaml written` }) };
          break;
        }
        case 'integrity': {
          if (!record.integrity || !fs.existsSync(record.integrity)) { check = { name, command: this.commandFor(record, name), status: 'failed', detail: 'the snapshot taken before the step is missing' }; break; }
          const r = await ruby(this.officeRoot, 'scripts/task-input-integrity.rb', ['verify', taskDir, record.taskId, record.role, record.integrity, '--office-dir', this.officeRoot], { env });
          check = fromScript(name, r, r.code === 0, r.code === 9 ? 'a protected task input (status.yaml, another role\'s output, a run record…) changed during the step' : undefined);
          break;
        }
        case 'validate': {
          const r = await ruby(this.officeRoot, 'validate-yaml.rb', [record.taskId]);
          check = fromScript(name, r, r.code === 0);
          break;
        }
        case 'enforce': {
          const r = await ruby(this.officeRoot, 'scripts/enforce-output-contract.rb', [record.taskId, record.role], { env });
          check = fromScript(name, r, r.code === 0, r.code === 0 ? 'output contract met' : r.code === 1 ? 'output contract failed: status.yaml set to validation_failed by the script' : undefined);
          break;
        }
        case 'sync': {
          const [phase, date] = [await this.config('state_model.reviewer_queue_phase', 'in_review'), today(this.now())];
          const r = await ruby(this.officeRoot, 'scripts/sync-status-from-output.rb', [record.taskId, record.role, path.join(taskDir, 'status.yaml'), output, date, phase], { env });
          let synced = false;
          try {
            const status = yaml.load(fs.readFileSync(path.join(taskDir, 'status.yaml'), 'utf8')) as { last_synced_output?: { digest?: string; file?: string } } | null;
            synced = status?.last_synced_output?.digest === sha256(output) && status?.last_synced_output?.file === path.basename(output);
          } catch { /* unreadable: not synced */ }
          check = r.code === 5
            ? fromScript(name, r, true, `completion blocked: status.yaml keeps its phase until the declared completion gates are resolved (${lastLine(r.stderr)})`)
            : fromScript(name, r, r.code === 0 && synced, r.code === 0 && !synced ? `status.yaml did not record this output: ${lastLine(r.stdout || r.stderr) || 'sync skipped it'}` : undefined);
          break;
        }
        default: continue;
      }
      checks.push(check);
      save();
      if (check.status !== 'passed') {
        const why = `not run: ${check.name === 'output' ? 'the step wrote no new output' : `${this.commandFor(record, check.name).split(' ')[1]?.replace(/^scripts\//, '') ?? check.name} failed`}`;
        for (const rest of CHECK_ORDER.slice(CHECK_ORDER.indexOf(name) + 1)) checks.push({ name: rest, command: this.commandFor(record, rest), status: 'skipped', detail: why });
        break;
      }
    }
    return checks;
  }

  /** Commits in a step worktree since the step started that the dashboard did not make (its commits carry this launch's Launch-Id trailer). */
  private async detectAgentCommits(record: StepRecord): Promise<TaskStepResult['agentCommits']> {
    const found: { repo: string; text: string }[] = [];
    for (const w of record.worktrees) {
      try {
        const head = (await git(w.path, ['rev-parse', 'HEAD'])).trim();
        const branch = (await git(w.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
        if (branch !== w.branch) found.push({ repo: w.repo, text: `the worktree is on ${branch || 'a detached HEAD'} now, not ${w.branch}` });
        if (!w.head || head === w.head) continue;
        const descends = await git(w.path, ['merge-base', '--is-ancestor', w.head, head]).then(() => true, () => false);
        if (!descends) { found.push({ repo: w.repo, text: `HEAD moved from ${w.head.slice(0, 10)} to ${head.slice(0, 10)}, which does not descend from it` }); continue; }
        const log = (await git(w.path, ['log', '--format=%H%x1f%s%x1f%(trailers:key=Launch-Id,valueonly,separator=%x2c)', `${w.head}..${head}`])).trim();
        for (const line of log.split('\n').filter(Boolean)) {
          const [sha, subject, launchId] = line.split('\x1f');
          if (launchId?.trim() !== record.launchId) found.push({ repo: w.repo, text: `${sha.slice(0, 10)} ${subject}` });
        }
      } catch (err) {
        found.push({ repo: w.repo, text: `could not read the worktree: ${(err as Error).message}` });
      }
    }
    return found.length
      ? { ok: false, text: `${found.length} commit${found.length === 1 ? '' : 's'} or branch change${found.length === 1 ? '' : 's'} the dashboard did not make: the step fails`, found }
      : { ok: true, text: record.worktrees.length ? 'no agent commit: every step worktree is at the HEAD it had before the step' : 'no worktrees to check', found };
  }

  private async commitAll(record: StepRecord): Promise<StepCommit[]> {
    const done = record.progress?.commits ?? [];
    const commits: StepCommit[] = [];
    const output = (() => { try { return yaml.load(fs.readFileSync(path.join(this.taskDir(record.taskId), `${record.role}-output.yaml`), 'utf8')) as { summary?: unknown } | null; } catch { return null; } })();
    const message = commitMessage({ taskId: record.taskId, role: record.role, cli: record.cli, model: record.model, launchId: record.launchId, runId: record.runId, summary: typeof output?.summary === 'string' ? output.summary : '' });
    for (const w of record.worktrees) {
      const previous = done.find((c) => c.repo === w.repo && c.status !== 'failed');
      commits.push(previous ?? await this.commitOne(record, w, message));
      record.progress = { checks: record.progress?.checks ?? [], commits: [...commits] };
      this.save(record);
    }
    return commits;
  }

  private async commitOne(record: StepRecord, w: StepWorktree, message: ReturnType<typeof commitMessage>): Promise<StepCommit> {
    const base = { repo: w.repo, path: w.path, branch: w.branch };
    try {
      // A restart between the commit and saving it: the commit is already there, with this launch's trailer.
      const head = (await git(w.path, ['rev-parse', 'HEAD'])).trim();
      if (w.head && head !== w.head) {
        const ours = (await git(w.path, ['log', '-1', '--format=%(trailers:key=Launch-Id,valueonly)', head])).trim();
        if (ours === record.launchId) return { ...base, status: 'committed', sha: head, subject: message.subject, text: `committed ${head.slice(0, 10)} on ${w.branch} (found after a restart)` };
      }
      // Tracked changes and new files, as .gitignore and info/exclude allow; then never the
      // step's own files. Not an :(exclude) pathspec: git add refuses one that names a path
      // ignored through info/exclude, which is where prepareWorkspace puts .cache/ and .cursor/.
      await git(w.path, ['add', '-A']);
      const staged = (await git(w.path, ['diff', '--cached', '--name-only', '--', ...NEVER_COMMIT])).trim();
      if (staged) await git(w.path, ['reset', '-q', '--', ...NEVER_COMMIT]);
      const files = (await git(w.path, ['diff', '--cached', '--name-only'])).split('\n').map((f) => f.trim()).filter(Boolean);
      if (!files.length) return { ...base, status: 'empty', text: `no changes in ${w.repo}: nothing to commit` };
      // Hooks off: core.hooksPath can point into the worktree, which the agent could write, and
      // the dashboard runs outside the sandbox. The operator's own identity and signing apply.
      await git(w.path, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--no-verify', '-m', message.subject, '-m', message.body, '-m', message.trailers.join('\n')]);
      const sha = (await git(w.path, ['rev-parse', 'HEAD'])).trim();
      const evidence = await run('bash', [path.join(this.officeRoot, 'scripts/record-evidence.sh'), record.taskId, '--type', 'artifact', '--', 'git', 'show', '--stat', '--format=fuller', sha],
        { cwd: w.path, env: { AI_DEV_OFFICE_RUN_ID: record.runId } });
      const evidenceId = /^ev-\d+$/m.exec(evidence.stdout)?.[0];
      return { ...base, status: 'committed', sha, subject: message.subject, files, ...(evidenceId ? { evidenceId } : {}),
        text: `committed ${sha.slice(0, 10)} on ${w.branch} (${files.length} file${files.length === 1 ? '' : 's'}), local only: never pushed${evidenceId ? `; evidence ${evidenceId}` : `; evidence not recorded (record-evidence.sh exit ${evidence.code})`}` };
    } catch (err) {
      return { ...base, status: 'failed', text: `commit failed: ${(err as Error).message}; the diff stays uncommitted` };
    }
  }

  private async complete(record: StepRecord, input: {
    protocol: TaskStepResult['protocol']; checks: StepCheck[]; agentCommits: TaskStepResult['agentCommits']; commits: StepCommit[]; exitCode: number | null; leaseLost?: string; termination?: RunTermination;
  }): Promise<TaskStepResult> {
    const taskDir = this.taskDir(record.taskId);
    const ran = input.checks.some((c) => c.status !== 'skipped');
    const verified = input.checks.length > 0 && input.checks.every((c) => c.status === 'passed');
    const ok = input.protocol.ok && verified && input.agentCommits.ok && !input.commits.some((c) => c.status === 'failed');
    await ruby(this.officeRoot, 'scripts/record-run.rb', ['finish', taskDir, record.runId,
      `outcome.status=${input.protocol.ok && input.agentCommits.ok ? 'completed' : 'failed'}`, `outcome.exit_code=${input.exitCode ?? ''}`,
      `outcome.termination=${input.termination ?? 'unknown'}`,
      `outcome.validation=${ran && !input.leaseLost ? (verified ? 'passed' : 'failed') : ''}`]);
    let lease: TaskStepResult['lease'];
    if (input.leaseLost) {
      lease = { ok: false, text: `lost before verification: ${input.leaseLost}` };
    } else {
      const released = await this.lease.release(record.grant, `dashboard step ${record.launchId}: ${ok ? 'verified' : 'ended'} (${input.protocol.text})`);
      lease = { ok: released.ok, text: released.ok ? (record.grant.disabled ? released.message : `held for the whole step, then ${released.message}`) : `release failed: ${released.message}` };
    }
    if (record.integrity) fs.rmSync(record.integrity, { force: true });
    const result: TaskStepResult = {
      state: 'done', launchId: record.launchId, runId: record.runId, role: record.role, cli: record.cli, ...(record.model ? { model: record.model } : {}),
      protocol: input.protocol, lease, checks: input.checks, verified, agentCommits: input.agentCommits, commits: input.commits,
      runsChanged: changes(record.runsBefore, listing(taskDir)), finishedAt: this.now().toISOString(),
    };
    record.result = result;
    delete record.progress;
    this.save(record);
    return result;
  }
}

import { Router } from 'express';
import fsSync from 'fs';
import fs from 'fs/promises';
import yaml from 'js-yaml';
import path from 'path';
import { config } from '../config';
import { localOnly } from '../middleware/localOnly';
import { resolveRunDir } from '../pathSecurity';
import { knowledgeRecheckPrompt } from '../services/knowledgeRecheckPrompt';
import { displayCommand, insideGitWorkTree, prepareWorkspace, stepArgs, stepEnv, type StepEnvelope } from '../services/cliAdapter';
import { CliProbe } from '../services/cliProbe';
import { CLAUDE_TASK_MODEL, CODEX_MODEL, KNOWLEDGE_MODEL, officeLauncher, stepTimeLimitMinutes, TASK_CLIS, TASK_ROLES, type TaskCli } from '../services/officeLauncher';
import { globalScanner } from '../services/runScanner';
import { StepGovernance, type StepRecord } from '../services/stepGovernance';
import { newTaskPmPrompt, recordedNextAction, taskPrompt, type PromptWorktree } from '../services/taskPrompt';
import { parseTargets, runEnvelope, runsOnlyEnvelope } from '../services/taskRun';
import {
  cleanupView, defaultTargets, ensureWorktrees, listRepos, planWorktree, proposeRepos, removeWorktree, WorktreeRegistry,
  type CleanupDeps, type WorktreeContext, type WorktreeTarget,
} from '../services/worktrees';
import type { OfficeLaunch, OpenTarget, RunQueueItem, TaskLaunchResponse, TaskOpenResponse, TaskWorkspaceResponse } from '../../../shared/types';
import { knowledgeReviewService } from './knowledgeReviews';
import { KnowledgeChain } from '../services/knowledgeChain';
import { HandoffStore, macOpener, OPEN_TARGETS, openAvailability, openRefusal, openStep } from '../services/openHandoff';
import { OPEN_PROMPT_CAP } from '../../../shared/openHandoff';
import { parseTrigger } from '../../../shared/runQueue';
import { QueueRefusedError, RunQueue, type StartOutcome } from '../services/runQueue';
import { ChainRefusedError, MAX_CHANGE_REQUESTS, TaskChains, WRITER_ROLES } from '../services/taskChain';
import { authorizationCheck, decideNextStep, reviewVerdict, taskHold } from '../services/chainOffice';
import { readEffectivePrefix, readTeamRegistry } from '../services/identity';
import { allowedPrefixes, gatesLine, NewTaskError, NewTaskFlow, NewTaskRefusedError, NewTasks, readPresets, TaskIdClaimer } from '../services/newTask';
import { ruby } from '../services/officeScripts';
import type { NewTaskOptions, NewTaskResponse, NewTaskView } from '../../../shared/types';

/** The model the dashboard runs a task step with: claude Opus 5.5 (DASHBOARD_CLAUDE_MODEL), codex the pinned catalog model, cursor-agent its default. */
const taskModel = (cli: TaskCli) => (cli === 'codex' ? CODEX_MODEL : cli === 'claude' ? CLAUDE_TASK_MODEL : undefined);

const router = Router();
router.use(localOnly);

// A task step runs in the task's worktrees (worktrees.ts: one per confirmed repository,
// the first one its working directory); the knowledge re-check runs at the workspace
// root. Each runs inside its CLI's sandbox (cliAdapter.ts), so it can write only in its
// working directory and the extra writable dirs (the task's other worktrees and its
// runs dir in this office checkout), with the network off.
//
// This is the one launch path for a task step (D8: the old /api/cli free-prompt runner
// is gone), and every Run goes through one file-backed queue (D13, runQueue.ts): a
// global cap, one step at a time per task, and triggers now / at a time / after another
// task's step. What the operator confirmed (role, CLI, repositories, note) is kept at
// enqueue; the prompt, worktrees and argv are decided when the item starts. The dashboard is the step's runtime adapter (stepGovernance.ts, D5/D6): it
// holds the task's ownership lease from before the worktrees are made until the
// verification and the commit are done, runs validate -> enforce -> sync itself, and
// commits each worktree's diff locally on the task branch. The knowledge re-check is
// not a task step: no lease, no verification, no commit. Open (POST .../open, D15) hands
// the same step to an app the operator drives instead: same worktrees, no lease, no
// verification, recorded on the task (openHandoff.ts).
const workspaceRoot = () => path.dirname(config.aiOfficeRoot);
const registry = new WorktreeRegistry(path.join(config.worktreesDir, '.dashboard-worktrees.json'));
const probe = new CliProbe();
const handoffs = new HandoffStore(config.runsDir);
const governance = new StepGovernance({ officeRoot: config.aiOfficeRoot, dir: officeLauncher.dir });
// Finalizes every task step that has ended, also the ones that ended while the dashboard
// was down (their leases are released then), right away and every few seconds.
const finalizeEnded = () => governance.tick(officeLauncher).catch((err) => console.warn('step finalize tick failed:', err));
finalizeEnded();
setInterval(finalizeEnded, 5_000).unref();

router.get('/tools', async (_req, res) => res.json({
  clis: (await probe.all()).map(({ id, usable, reason, note, model }) => ({ id, available: usable, ...(reason ? { reason } : {}), ...(note ? { note } : {}), ...(model ? { model } : {}) })),
  roles: TASK_ROLES,
  timeLimitMinutes: config.stepTimeLimitMinutes,
  queueCap: config.runConcurrency,
  open: { ...openAvailability(process.platform), promptCap: OPEN_PROMPT_CAP },
  chain: { ...config.chainPairing, cap: config.chainStepCap, writerRoles: [...WRITER_ROLES], maxChangeRequests: MAX_CHANGE_REQUESTS },
}));

/** The CLI's executable, or an error with the reason it cannot run a step. */
async function usableCli(cli: TaskCli) {
  const usable = await probe.usability(cli);
  if (!usable.usable || !usable.executable) throw Object.assign(new Error(`${cli} cannot run a step: ${usable.reason}.`), { status: 400 });
  return usable.executable;
}

/** Starts one sandboxed step of `cli` with the prompt on stdin; throws with the reason when it cannot. */
async function startStep(input: { cli: TaskCli; envelope: StepEnvelope; prompt: string; promptLabel: string; kind: OfficeLaunch['kind']; key: string; label: string; role?: string;
  id?: string; heartbeat?: { argv: string[]; intervalMs: number };
  /** false: write nothing into the working directory first (a runs-only step: no .cache/ in runs/<TASK>, no info/exclude edit). */
  prepare?: boolean }) {
  const executable = await usableCli(input.cli);
  const envelope = { ...input.envelope, notGitRepo: !insideGitWorkTree(input.envelope.cwd) };
  if (input.prepare !== false) prepareWorkspace(input.cli, envelope);
  const args = stepArgs(input.cli, envelope);
  return officeLauncher.start({
    kind: input.kind, key: input.key, label: input.label, cwd: input.envelope.cwd, ...(input.role ? { role: input.role } : {}),
    argv: [executable.command, ...executable.prefix, ...args], stdin: input.prompt, env: stepEnv(input.cli, input.envelope.cwd),
    stream: input.cli, timeLimitMs: stepTimeLimitMinutes(input.kind === 'knowledge' ? 'knowledge' : 'task', config) * 60_000, ...(input.id ? { id: input.id } : {}), ...(input.heartbeat ? { heartbeat: input.heartbeat } : {}),
    display: `${displayCommand(input.cli, args)} < ${input.promptLabel} on stdin  (cwd ${input.envelope.cwd})`,
  });
}

/** The knowledge run must not commit, move branches or delete files: denied on top of the envelope's git push. */
const KNOWLEDGE_DENY = ['Bash(git commit *)', 'Bash(git reset *)', 'Bash(git checkout *)', 'Bash(rm *)'];

/** One knowledge round (a queue item): the weekly re-check with a brief built now; null when nothing is in scope. */
async function startKnowledgeRound(item: RunQueueItem): Promise<StartOutcome | null> {
  const prompt = knowledgeRecheckPrompt(await knowledgeReviewService.recheckBrief('task'), workspaceRoot());
  if (!prompt) return null;
  return { launch: await startStep({
    cli: 'claude', kind: 'knowledge', key: 'knowledge', label: 'Knowledge re-check', prompt, promptLabel: 'weekly re-check prompt + brief',
    envelope: { cwd: workspaceRoot(), writableDirs: [], model: KNOWLEDGE_MODEL, extraDeny: KNOWLEDGE_DENY }, ...(item.launchId ? { id: item.launchId } : {}),
  }) };
}

// Command › Operations › Running now: what is actually executing from a Start button.
// A list: the raw log and the progress lines stay on the task's launch view.
router.get('/active', (_req, res) => res.json({ launches: officeLauncher.active().map(({ log, progress, ...rest }) => rest) }));

router.get('/knowledge', (_req, res) => {
  const queued = queue.pending('knowledge');
  return res.json({ launch: officeLauncher.latest('knowledge'), chain: knowledgeChain.view(), ...(queued ? { queued: queue.itemView(queued.id) } : {}) });
});

router.post('/knowledge', async (req, res) => {
  const rounds = Number(req.body?.rounds ?? 1);
  try {
    const { launch, chain, queued } = await knowledgeChain.start(rounds);
    if (queued) return res.status(202).json({ launch: null, chain, queued });
    if (!launch) return res.status(409).json({ error: 'Nothing to re-check: no open findings in the approved scope and no operator answers waiting.' });
    return res.status(201).json({ launch, chain });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Launch failed.';
    return res.status(/Rounds must/.test(message) ? 400 : err instanceof QueueRefusedError ? err.status : /brief|policy/i.test(message) ? 503 : 409).json({ error: message });
  }
});

router.post('/knowledge/stop', (_req, res) => res.json({ launch: knowledgeChain.stop(), chain: knowledgeChain.view() }));

router.get('/task/:taskId', async (req, res) => {
  const dir = resolveRunDir(config.runsDir, req.params.taskId);
  if (!dir.ok) return res.status(dir.code).json({ error: dir.error });
  const launch = officeLauncher.latest(req.params.taskId);
  const body: TaskLaunchResponse = { launch };
  if (launch && !['running', 'stopping'].includes(launch.status)) {
    // An ended step is verified and committed once (a few seconds of office scripts);
    // a launch from before slice 3 has no step record and no result.
    if (governance.view(launch.id)?.state === 'verifying') await governance.finalize(launch).catch((err) => console.warn(`finalizing ${launch.id} failed:`, err));
    const result = governance.view(launch.id);
    if (result) body.result = result;
  }
  // Read after finalizing: the warning compares it with when the dashboard's own sync ended.
  try { body.statusChangedAt = (await fs.stat(path.join(dir.runDir, 'status.yaml'))).mtime.toISOString(); } catch { /* no status yet */ }
  // An Open session takes no lease: the newest hand-off lets the dialog warn a later Run (D8).
  const lastHandoff = await handoffs.latest(req.params.taskId);
  if (lastHandoff) body.lastHandoff = lastHandoff;
  const queued = queue.pending(req.params.taskId);
  if (queued) body.queued = queue.itemView(queued.id);
  // A queued step that could not start, unless a launch started after it.
  const failed = queue.lastUnstarted(req.params.taskId);
  if (failed?.state === 'failed' && (!launch || (failed.endedAt ?? '') > launch.startedAt)) body.queueFailed = failed;
  const chain = chains.latest(req.params.taskId);
  if (chain) body.chain = chains.view(chain.id) ?? undefined;
  return res.json(body);
});

interface TaskFiles { runDir: string; title: string; taskMarkdown: string; nextAction: ReturnType<typeof recordedNextAction> }

/** The task's run dir and task.md, or why there are none. */
async function taskFiles(taskId: string): Promise<TaskFiles | { status: number; error: string }> {
  const dir = resolveRunDir(config.runsDir, taskId);
  if (!dir.ok) return { status: dir.code, error: dir.error };
  const detail = await globalScanner.getRunDetail(taskId);
  if (!detail?.taskMarkdown) return { status: 404, error: 'Task not found.' };
  return { runDir: dir.runDir, title: detail.title, taskMarkdown: detail.taskMarkdown, nextAction: recordedNextAction(detail.statusRaw) };
}

const worktreeContext = (taskId: string, taskMarkdown: string): WorktreeContext => ({
  workspaceRoot: workspaceRoot(), worktreesRoot: config.worktreesDir, task: taskId, registry, taskMarkdown,
});

/** Repositories task.md names, matched against the real ones, and a plan per target (the preselected ones when none are given). */
async function workspaceView(taskId: string, files: TaskFiles, targets?: WorktreeTarget[]): Promise<TaskWorkspaceResponse> {
  const repos = listRepos(workspaceRoot());
  const { proposed, referenceOnly } = proposeRepos(files.taskMarkdown, repos);
  const ctx = worktreeContext(taskId, files.taskMarkdown);
  const plans = await Promise.all((targets ?? defaultTargets(proposed)).map((t) => planWorktree(ctx, t)));
  return { repos: repos.filter((r) => !r.readOnly).map((r) => r.name), proposed, referenceOnly, plans };
}

const errorBody = (err: unknown, fallback: string) => ({ status: (err as { status?: number }).status ?? 409, body: { error: err instanceof Error ? err.message : fallback } });

// Run › repositories: proposed from task.md (GET) and planned for the operator's list
// (POST) before anything is created. The first repository is the primary (the step's
// working directory).
router.get('/task/:taskId/workspace', async (req, res) => {
  const files = await taskFiles(req.params.taskId);
  if ('error' in files) return res.status(files.status).json({ error: files.error });
  try { return res.json(await workspaceView(req.params.taskId, files)); }
  catch (err) { const e = errorBody(err, 'Could not read the repositories.'); return res.status(e.status).json(e.body); }
});

router.post('/task/:taskId/workspace', async (req, res) => {
  const files = await taskFiles(req.params.taskId);
  if ('error' in files) return res.status(files.status).json({ error: files.error });
  const targets = parseTargets(req.body);
  if ('error' in targets) return res.status(400).json({ error: targets.error });
  try { return res.json(await workspaceView(req.params.taskId, files, targets)); }
  catch (err) { const e = errorBody(err, 'Could not plan the worktrees.'); return res.status(e.status).json(e.body); }
});

/** Role and note from the request, or why they are not usable. */
function roleAndNote(body: unknown): { role: string; note?: string } | { status: number; error: string } {
  const { role, note } = (body ?? {}) as { role?: unknown; note?: unknown };
  if (!(TASK_ROLES as readonly string[]).includes(String(role))) return { status: 400, error: `Role must be one of ${TASK_ROLES.join(', ')}.` };
  if (typeof note !== 'undefined' && (typeof note !== 'string' || note.length > 4000)) return { status: 400, error: 'Note must be text of at most 4,000 characters.' };
  return { role: String(role), ...(typeof note === 'string' ? { note } : {}) };
}

const buildPrompt = (taskId: string, files: TaskFiles, role: string, note: string | undefined, worktrees: PromptWorktree[], referenceOnly: string[], mode: 'run' | 'open' = 'run') => taskPrompt({
  taskId, title: files.title, role, workspaceRoot: workspaceRoot(), officeRoot: config.aiOfficeRoot, worktrees, referenceOnly, note, nextAction: files.nextAction, mode,
});

/** The step in flight on the task (running, or ended and still being verified), as a refusal; null when there is none. */
function stepInFlight(taskId: string): string | null {
  const current = officeLauncher.latest(taskId);
  if (current && ['running', 'stopping'].includes(current.status)) return `${current.label} is already running (started ${current.startedAt}).`;
  if (governance.pending(taskId)) return `The previous step on ${taskId} is still being verified and committed; start the next one when it is done.`;
  return null;
}

// New task (D11, newTask.ts): the tasks opened here and their runs-only pm steps. Defined
// before the queue: a pm step left waiting by a restart starts on the queue's first tick.
const newTasks: NewTasks = new NewTasks(config.newTasksFile, {
  queue: { get: (id) => queue.get(id), itemView: (id) => queue.itemView(id) },
  launches: officeLauncher, result: (launchId) => governance.view(launchId),
});

const queue: RunQueue = new RunQueue(config.queueFile, {
  launches: officeLauncher, cap: config.runConcurrency, busy: stepInFlight, newLaunchId: () => officeLauncher.newId(),
  verifying: (launchId) => governance.view(launchId)?.state === 'verifying',
  start: (item) => (item.kind === 'knowledge' ? startKnowledgeRound(item) : startQueuedStep(item)),
  // After-chain triggers (D12) read the role chains; `chains` is defined right below.
  chains: { get: (id) => chains.get(id), latest: (taskId) => chains.latest(taskId) },
});
const knowledgeChain = new KnowledgeChain(officeLauncher, queue, config.knowledgeChainFile);
// Role chains (D12, taskChain.ts): each step a queue item; the next role from
// scripts/decide-next-step.rb once the step is verified, or a recorded stop.
const chains: TaskChains = new TaskChains(config.chainsFile, {
  queue, launches: officeLauncher, result: (launchId) => governance.view(launchId),
  decide: (taskId, role) => decideNextStep(config.aiOfficeRoot, taskId, role),
  authorize: (taskId, role) => authorizationCheck(config.aiOfficeRoot, taskId, role),
  hold: (taskId) => taskHold(config.runsDir, taskId),
  verdict: (taskId) => reviewVerdict(config.runsDir, taskId),
  usable: (cli) => probe.usability(cli),
  model: taskModel,
  previousWriter: (taskId) => {
    const last = officeLauncher.latest(taskId);
    return last?.kind === 'task' && last.cli && (WRITER_ROLES as readonly string[]).includes(last.role ?? '') ? last.cli : undefined;
  },
  defaults: { pairing: config.chainPairing, cap: config.chainStepCap },
});
// One timer advances the knowledge chain (it queues its next round), the role chains
// (they queue their next step) and then the queue, also after a dashboard restart: all
// three are on disk.
queue.startTimer(5_000, async () => {
  await knowledgeChain.tick().catch((err) => console.warn('knowledge chain tick failed:', err));
  await chains.tick().catch((err) => console.warn('role chain tick failed:', err));
});
queue.tick().catch((err) => console.warn('run queue tick failed:', err));

/** The planned worktrees as the prompt names them (nothing is created). */
const plannedWorktrees = (view: TaskWorkspaceResponse): PromptWorktree[] => view.plans
  .filter((p) => p.action !== 'refuse' && p.path && p.branch).map((p) => ({ repo: p.repo, path: p.path!, branch: p.branch! }));

/**
 * Starts a queued task step (D13): everything but what the operator confirmed is decided
 * now. Throws with the reason it cannot start (task gone, CLI unusable, lease held by
 * another holder, a worktree refused); the queue records it as failed.
 */
async function startQueuedStep(item: RunQueueItem): Promise<StartOutcome> {
  const taskId = item.key;
  const step = item.step;
  if (!step || !item.launchId) throw new Error('The queue item has no step to run.');
  const files = await taskFiles(taskId);
  if ('error' in files) throw Object.assign(new Error(files.error), { status: files.status });
  let record: StepRecord | undefined;
  try {
    await usableCli(step.cli);
    const model = taskModel(step.cli);
    const id = item.launchId;
    if (step.runsOnly) {
      // New task's pm step (D11): no worktree. Its working directory is runs/<TASK>, the
      // only place it writes; the prompt comes from the New task record (the request).
      const opened = newTasks.get(taskId);
      if (!opened) throw Object.assign(new Error(`${taskId} has no New task record (the request): run pm from Start or open task instead.`), { status: 404 });
      const envelope = runsOnlyEnvelope(step.cli, files.runDir, model);
      record = await governance.begin({ launchId: id, taskId, role: step.role, cli: step.cli, model });
      const prompt = newTaskPmPrompt({
        taskId, title: files.title, workspaceRoot: workspaceRoot(), officeRoot: config.aiOfficeRoot, request: opened.request, gates: gatesLine(opened.gates), note: step.note,
      });
      await governance.attachWorktrees(record, [], prompt);
      const launch = await startStep({
        cli: step.cli, kind: 'task', key: taskId, label: `${taskId} ${step.role}`, role: step.role, id, heartbeat: governance.heartbeat(record),
        prompt, promptLabel: `new-task pm prompt for ${taskId}`, envelope, prepare: false,
      });
      governance.markStarted(record);
      return { launch, detail: { lease: record.grant.message, runsOnly: files.runDir } };
    }
    // D6/D8: the task's ownership lease first (refused with the holder and the reason),
    // held for the whole step: released after verification and the commit, or on any failure.
    record = await governance.begin({ launchId: id, taskId, role: step.role, cli: step.cli, model });
    const ctx = worktreeContext(taskId, files.taskMarkdown);
    const ensured = await ensureWorktrees(ctx, step.repos);
    const records = ensured.map((e) => e.record);
    const { referenceOnly } = proposeRepos(files.taskMarkdown, listRepos(workspaceRoot()));
    const prompt = buildPrompt(taskId, files, step.role, step.note, records, referenceOnly.map((r) => r.repo));
    await governance.attachWorktrees(record, records.map((r) => ({ repo: r.repo, path: r.path, branch: r.branch })), prompt);
    const launch = await startStep({
      cli: step.cli, kind: 'task', key: taskId, label: `${taskId} ${step.role}`, role: step.role, id, heartbeat: governance.heartbeat(record),
      prompt, promptLabel: `${step.role} prompt for ${taskId}`,
      envelope: runEnvelope(step.cli, records, files.runDir, model),
    });
    governance.markStarted(record);
    return { launch, detail: { lease: record.grant.message, worktrees: ensured.map((e) => ({ ...e.record, warnings: e.plan.warnings, ...(e.note ? { note: e.note } : {}) })) } };
  } catch (err) {
    // The step never started: give the lease back and record why.
    if (record && !officeLauncher.get(record.launchId)) await governance.abort(record, err instanceof Error ? err.message : 'launch failed').catch((e) => console.warn('abort failed:', e));
    throw err;
  }
}

// Run: queue the step (trigger now by default) and advance the queue at once, so a "now"
// under the cap starts in this request (201 with the launch), else waits (202 with the
// queue item). A start that is refused answers 409 with the reason (the item stays on
// record as failed). Nothing is queued for a CLI that cannot run, and a "now" is refused
// while a step runs or is being verified on the task (D8), like before the queue.
router.post('/task/:taskId', async (req, res) => {
  const { taskId } = req.params;
  const files = await taskFiles(taskId);
  if ('error' in files) return res.status(files.status).json({ error: files.error });
  const step = roleAndNote(req.body);
  if ('error' in step) return res.status(step.status).json({ error: step.error });
  const cli = String(req.body?.cli);
  if (!(TASK_CLIS as readonly string[]).includes(cli)) return res.status(400).json({ error: `CLI must be one of ${TASK_CLIS.join(', ')}.` });
  const targets = parseTargets(req.body);
  if ('error' in targets) return res.status(400).json({ error: targets.error });
  if (!targets.length) return res.status(400).json({ error: 'Confirm at least one target repository: a Run works in a task worktree, never at the workspace root.' });
  const trigger = parseTrigger(req.body?.trigger, new Date());
  if ('error' in trigger) return res.status(400).json({ error: trigger.error });
  if (trigger.kind === 'after' && trigger.taskId !== taskId) {
    const other = resolveRunDir(config.runsDir, trigger.taskId);
    if (!other.ok || !fsSync.existsSync(other.runDir)) return res.status(400).json({ error: `No task ${trigger.taskId} to wait for.` });
  }
  const chain = chains.active(taskId);
  if (chain) return res.status(409).json({ error: `A role chain is running on ${taskId} (step ${chain.steps.length}); stop it before a single Run.` });
  try {
    await usableCli(cli as TaskCli);
    const inFlight = trigger.kind === 'now' ? stepInFlight(taskId) : null;
    if (inFlight) return res.status(409).json({ error: inFlight });
    const item = queue.enqueue({ kind: 'task', key: taskId, label: `${taskId} ${step.role}`, trigger,
      step: { role: step.role, cli: cli as TaskCli, repos: targets, ...(step.note ? { note: step.note } : {}) } });
    await queue.tick();
    const now = queue.itemView(item.id) ?? item;
    if (now.state === 'failed') return res.status(409).json({ error: now.reason ?? 'The step could not start.', item: now });
    if (now.state === 'started' && now.launchId) return res.status(201).json({ launch: officeLauncher.get(now.launchId), item: now, ...(queue.takeDetail(item.id) ?? {}) });
    return res.status(202).json({ launch: null, item: now });
  } catch (err) {
    const e = errorBody(err, 'Launch failed.');
    return res.status(e.status).json(e.body);
  }
});

// Run until a human is needed (D12): a role chain from `role`, each step an ordinary
// queued Run on the pairing's CLI (writer for pm/dev/dev-2/debugger/devops, reviewer for
// reviewer; overridable per chain with writer/reviewer, and the step cap with cap). The
// first step takes the trigger and the note; the chain refuses to start (409 with the
// reason) where it would stop at once. 201 with the chain and the launch when step 1
// started, 202 when it waits in the queue.
router.post('/task/:taskId/chain', async (req, res) => {
  const { taskId } = req.params;
  const files = await taskFiles(taskId);
  if ('error' in files) return res.status(files.status).json({ error: files.error });
  const step = roleAndNote(req.body);
  if ('error' in step) return res.status(step.status).json({ error: step.error });
  const targets = parseTargets(req.body);
  if ('error' in targets) return res.status(400).json({ error: targets.error });
  if (!targets.length) return res.status(400).json({ error: 'Confirm at least one target repository: a Run works in a task worktree, never at the workspace root.' });
  const trigger = parseTrigger(req.body?.trigger, new Date());
  if ('error' in trigger) return res.status(400).json({ error: trigger.error });
  if (trigger.kind === 'after' && trigger.taskId !== taskId) {
    const other = resolveRunDir(config.runsDir, trigger.taskId);
    if (!other.ok || !fsSync.existsSync(other.runDir)) return res.status(400).json({ error: `No task ${trigger.taskId} to wait for.` });
  }
  const { writer, reviewer, cap } = (req.body ?? {}) as { writer?: unknown; reviewer?: unknown; cap?: unknown };
  for (const [name, v] of [['writer', writer], ['reviewer', reviewer]] as const) {
    if (v !== undefined && !(TASK_CLIS as readonly string[]).includes(String(v))) return res.status(400).json({ error: `${name} must be one of ${TASK_CLIS.join(', ')}.` });
  }
  if (cap !== undefined && typeof cap !== 'number') return res.status(400).json({ error: 'cap must be a number.' });
  // D11: a task opened from New task starts no chain until the operator confirmed its task.md.
  const unconfirmed = newTasks.chainHold(taskId);
  if (unconfirmed) return res.status(409).json({ error: unconfirmed });
  const inFlight = trigger.kind === 'now' ? stepInFlight(taskId) : null;
  if (inFlight) return res.status(409).json({ error: inFlight });
  try {
    const { chain, item } = await chains.start({
      taskId, role: step.role, repos: targets, ...(step.note ? { note: step.note } : {}), trigger,
      pairing: { ...(writer ? { writer: writer as TaskCli } : {}), ...(reviewer ? { reviewer: reviewer as TaskCli } : {}) }, ...(typeof cap === 'number' ? { cap } : {}),
    });
    if (item.state === 'failed') return res.status(409).json({ error: item.reason ?? 'The first step could not start.', item, chain });
    if (item.state === 'started' && item.launchId) return res.status(201).json({ launch: officeLauncher.get(item.launchId), item, chain, ...(queue.takeDetail(item.id) ?? {}) });
    return res.status(202).json({ launch: null, item, chain });
  } catch (err) {
    const status = err instanceof ChainRefusedError || err instanceof QueueRefusedError ? err.status : 409;
    return res.status(status).json({ error: err instanceof Error ? err.message : 'The chain could not start.' });
  }
});

router.post('/task/:taskId/chain/stop', (req, res) => {
  const chain = chains.stop(req.params.taskId);
  if (!chain) return res.status(404).json({ error: `No role chain on ${req.params.taskId}.` });
  return res.json({ launch: officeLauncher.latest(req.params.taskId), chain });
});

// Command › Operations › Running now: the role chains running now, with their timelines.
router.get('/chains', (_req, res) => res.json({ chains: chains.running() }));

// The Run queue (D13): waiting items (oldest first, with what each waits for), the cap,
// what runs now, and the last ended items; cancel a waiting item before it starts.
router.get('/queue', (_req, res) => res.json(queue.view()));

router.post('/queue/:id/cancel', (req, res) => {
  try { return res.json({ item: queue.cancel(req.params.id), queue: queue.view() }); }
  catch (err) { const e = errorBody(err, 'Cancel failed.'); return res.status(e.status).json(e.body); }
});

// The exact prompt a Run would send, for review before starting: with the worktrees
// planned for the repositories in the request (nothing is created to preview it).
router.post('/task/:taskId/prompt', async (req, res) => {
  const { taskId } = req.params;
  const files = await taskFiles(taskId);
  if ('error' in files) return res.status(files.status).json({ error: files.error });
  const step = roleAndNote(req.body);
  if ('error' in step) return res.status(step.status).json({ error: step.error });
  const targets = parseTargets(req.body);
  if ('error' in targets) return res.status(400).json({ error: targets.error });
  const mode = req.body?.mode === 'open' ? 'open' : 'run';
  try {
    const view = await workspaceView(taskId, files, targets);
    return res.json({ prompt: buildPrompt(taskId, files, step.role, step.note, plannedWorktrees(view), view.referenceOnly.map((r) => r.repo), mode) });
  } catch (err) { const e = errorBody(err, 'Could not build the prompt.'); return res.status(e.status).json(e.body); }
});

// Open (D15): hand the step to an app the operator drives, on the task's worktrees (made
// or reused like a Run's), with the open-mode prompt prefilled and not sent. No lease:
// the hand-off is recorded on the task instead (open-handoffs.yaml), so a later Run
// warns. The platform and the prompt cap are checked before any worktree is made.
router.post('/task/:taskId/open', async (req, res) => {
  const { taskId } = req.params;
  const files = await taskFiles(taskId);
  if ('error' in files) return res.status(files.status).json({ error: files.error });
  const step = roleAndNote(req.body);
  if ('error' in step) return res.status(step.status).json({ error: step.error });
  const target = String(req.body?.target) as OpenTarget;
  if (!(OPEN_TARGETS as readonly string[]).includes(target)) return res.status(400).json({ error: `Target must be one of ${OPEN_TARGETS.join(', ')}.` });
  const targets = parseTargets(req.body);
  if ('error' in targets) return res.status(400).json({ error: targets.error });
  if (!targets.length) return res.status(400).json({ error: 'Confirm at least one target repository: Open works on a task worktree, never at the workspace root.' });
  // A session on the same worktree while a Run writes there would collide.
  const inFlight = stepInFlight(taskId);
  if (inFlight) return res.status(409).json({ error: inFlight });
  try {
    const view = await workspaceView(taskId, files, targets);
    const referenceOnly = view.referenceOnly.map((r) => r.repo);
    const refused = openRefusal(target, buildPrompt(taskId, files, step.role, step.note, plannedWorktrees(view), referenceOnly, 'open'), process.platform);
    if (refused) return res.status(refused.status).json({ error: refused.message });
    const ensured = await ensureWorktrees(worktreeContext(taskId, files.taskMarkdown), targets);
    const records = ensured.map((e) => e.record);
    const prompt = buildPrompt(taskId, files, step.role, step.note, records, referenceOnly, 'open');
    const { handoff, url } = await openStep({ platform: process.platform, opener: macOpener, store: handoffs }, { taskId, target, role: step.role, prompt, worktrees: records });
    const body: TaskOpenResponse = { handoff, prompt, ...(url ? { url } : {}), worktrees: ensured.map((e) => ({ ...e.record, warnings: e.plan.warnings, ...(e.note ? { note: e.note } : {}) })) };
    return res.status(201).json(body);
  } catch (err) { const e = errorBody(err, 'Open failed.'); return res.status(e.status).json(e.body); }
});

// Command › Operations › Task worktrees (D14): the worktrees the dashboard created
// (never adopted ones, never anything outside its registry), each with why it is or
// is not removable now; removal only on the operator's explicit confirmation.
const cleanupDeps: CleanupDeps = {
  taskPhase: async (task) => {
    const dir = resolveRunDir(config.runsDir, task);
    if (!dir.ok) return undefined;
    try {
      const phase = (yaml.load(await fs.readFile(path.join(dir.runDir, 'status.yaml'), 'utf8')) as { phase?: unknown } | null)?.phase;
      return typeof phase === 'string' ? phase : undefined;
    } catch { return undefined; }
  },
  running: (task) => ['running', 'stopping'].includes(officeLauncher.latest(task)?.status ?? '') || governance.pending(task),
};

router.get('/worktrees', async (_req, res) => {
  const created = registry.list().filter((r) => r.origin === 'created');
  return res.json({ worktrees: await Promise.all(created.map((r) => cleanupView(r, cleanupDeps))) });
});

router.post('/worktrees/remove', async (req, res) => {
  const { task, repo, confirm, deleteBranch } = (req.body ?? {}) as Record<string, unknown>;
  if (confirm !== true) return res.status(400).json({ error: 'Removing a worktree needs confirm: true.' });
  if (typeof task !== 'string' || typeof repo !== 'string') return res.status(400).json({ error: 'task and repo are required.' });
  if (deleteBranch !== undefined && typeof deleteBranch !== 'boolean') return res.status(400).json({ error: 'deleteBranch must be true or false.' });
  try { return res.json(await removeWorktree(registry, task, repo, cleanupDeps, deleteBranch === true)); }
  catch (err) { const e = errorBody(err, 'Removal failed.'); return res.status(e.status).json(e.body); }
});

// Command › New task (D11): the operator's request → open-task.rb claims the id in this
// office checkout (config.aiOfficeRoot, the main checkout the dashboard runs in) → a
// runs-only pm step through the queue → stop: the operator reads task.md and confirms
// (then starts a chain from the Start dialog) or closes it here.
const claimer = new TaskIdClaimer({
  officeRoot: config.aiOfficeRoot,
  run: (args, env) => ruby(config.aiOfficeRoot, 'scripts/open-task.rb', args, { env }),
});

/** Prefixes and presets the form may offer now (read on every request: the registry and identity can change). */
async function formOptions() {
  const [registry, effective] = await Promise.all([readTeamRegistry(config.aiOfficeRoot), readEffectivePrefix(config.aiOfficeRoot)]);
  return { prefixes: allowedPrefixes(registry, effective.taskPrefix), ...readPresets(config.aiOfficeRoot) };
}

const newTaskFlow = new NewTaskFlow({
  claimer, store: newTasks, queue, launches: officeLauncher, writer: config.chainPairing.writer, usable: (cli) => probe.usability(cli),
  options: async () => { const o = await formOptions(); return { prefixes: o.prefixes.allowed, presets: o.presets.map((p) => p.name) }; },
});

/** The view with task.md, the repositories a Run would preselect, and next_action, once the pm step is verified. */
async function newTaskDetail(view: NewTaskView): Promise<NewTaskView> {
  if (!['review', 'confirmed'].includes(view.state)) return view;
  const files = await taskFiles(view.taskId);
  if ('error' in files) return view;
  const { proposed, referenceOnly } = proposeRepos(files.taskMarkdown, listRepos(workspaceRoot()));
  // The sync moves current_agent, not next_action: the pm output's next_action says what comes next.
  let nextAction = files.nextAction;
  if (!nextAction) {
    try { nextAction = recordedNextAction(yaml.load(await fs.readFile(path.join(files.runDir, 'pm-output.yaml'), 'utf8'))); } catch { /* no pm output */ }
  }
  return {
    ...view, taskMarkdown: files.taskMarkdown, proposed: proposed.filter((p) => p.preselected).map((p) => p.repo), referenceOnly: referenceOnly.map((p) => p.repo),
    ...(nextAction ? { nextAction } : {}),
  };
}

const newTaskError = (res: import('express').Response, err: unknown) => {
  const status = err instanceof NewTaskError || err instanceof NewTaskRefusedError ? err.status : 500;
  return res.status(status).json({ error: err instanceof Error ? err.message : 'New task failed.', ...(err instanceof NewTaskError && err.attempts.length ? { attempts: err.attempts } : {}) });
};

router.get('/new-task', async (_req, res) => {
  const o = await formOptions();
  const writer = config.chainPairing.writer;
  const usable = writer === 'cursor-agent' ? { usable: false, reason: 'a runs-only pm step needs claude or codex (DASHBOARD_CHAIN_WRITER_CLI)' } : await probe.usability(writer);
  const body: NewTaskOptions = {
    prefixes: o.prefixes, presets: o.presets, ...(o.error ? { presetsError: o.error } : {}),
    writer: { cli: writer, usable: usable.usable, ...(usable.reason ? { reason: usable.reason } : {}) },
    tasks: await Promise.all(newTasks.open().map(newTaskDetail)),
  };
  return res.json(body);
});

// 201 once the id is claimed: the pm step is queued (started when a slot was free), or
// the task view says why it could not be (the task stays opened). Refusals before the
// claim answer 400; open-task.rb's own refusals 403 (namespace) / 400 / 500 with its
// message; ids lost to other lanes too many times in a row 409.
router.post('/new-task', async (req, res) => {
  try {
    const { task, attempts, launch } = await newTaskFlow.create(req.body);
    const body: NewTaskResponse = { task: await newTaskDetail(task), attempts, launch };
    return res.status(201).json(body);
  } catch (err) { return newTaskError(res, err); }
});

router.get('/new-task/:taskId', async (req, res) => {
  const view = newTasks.view(req.params.taskId);
  if (!view) return res.status(404).json({ error: `${req.params.taskId} was not opened from New task.` });
  return res.json({ task: await newTaskDetail(view) });
});

router.post('/new-task/:taskId/confirm', async (req, res) => {
  try { return res.json({ task: await newTaskDetail(newTasks.confirm(req.params.taskId)) }); }
  catch (err) { return newTaskError(res, err); }
});

router.post('/new-task/:taskId/close', async (req, res) => {
  try { return res.json({ task: newTasks.close(req.params.taskId) }); }
  catch (err) { return newTaskError(res, err); }
});

router.post('/new-task/:taskId/redo', async (req, res) => {
  try {
    const { task, launch } = await newTaskFlow.redo(req.params.taskId, req.body?.note);
    return res.status(201).json({ task: await newTaskDetail(task), launch });
  } catch (err) { return newTaskError(res, err); }
});

router.post('/:id/stop', (req, res) => {
  try { return res.json({ launch: officeLauncher.stop(req.params.id) }); }
  catch (err) { return res.status(404).json({ error: err instanceof Error ? err.message : 'Stop failed.' }); }
});

export default router;

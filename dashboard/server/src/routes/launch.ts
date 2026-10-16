import { Router } from 'express';
import fs from 'fs/promises';
import yaml from 'js-yaml';
import path from 'path';
import { config } from '../config';
import { localOnly } from '../middleware/localOnly';
import { resolveRunDir } from '../pathSecurity';
import { knowledgeRecheckPrompt } from '../services/knowledgeRecheckPrompt';
import { displayCommand, insideGitWorkTree, prepareWorkspace, stepArgs, stepEnv, type StepEnvelope } from '../services/cliAdapter';
import { CliProbe } from '../services/cliProbe';
import { CLAUDE_TASK_MODEL, CODEX_MODEL, KNOWLEDGE_MODEL, officeLauncher, TASK_CLIS, TASK_ROLES, type TaskCli } from '../services/officeLauncher';
import { globalScanner } from '../services/runScanner';
import { StepGovernance, type StepRecord } from '../services/stepGovernance';
import { recordedNextAction, taskPrompt, type PromptWorktree } from '../services/taskPrompt';
import { parseTargets, runEnvelope } from '../services/taskRun';
import {
  cleanupView, defaultTargets, ensureWorktrees, listRepos, planWorktree, proposeRepos, removeWorktree, WorktreeRegistry,
  type CleanupDeps, type WorktreeContext, type WorktreeTarget,
} from '../services/worktrees';
import type { OfficeLaunch, TaskLaunchResponse, TaskWorkspaceResponse } from '../../../shared/types';
import { knowledgeReviewService } from './knowledgeReviews';
import { KnowledgeChain } from '../services/knowledgeChain';

const router = Router();
router.use(localOnly);

// A task step runs in the task's worktrees (worktrees.ts: one per confirmed repository,
// the first one its working directory); the knowledge re-check runs at the workspace
// root. Each runs inside its CLI's sandbox (cliAdapter.ts), so it can write only in its
// working directory and the extra writable dirs (the task's other worktrees and its
// runs dir in this office checkout), with the network off.
//
// This is the one launch path for a task step (D8: the old /api/cli free-prompt runner
// is gone). The dashboard is the step's runtime adapter (stepGovernance.ts, D5/D6): it
// holds the task's ownership lease from before the worktrees are made until the
// verification and the commit are done, runs validate -> enforce -> sync itself, and
// commits each worktree's diff locally on the task branch. The knowledge re-check is
// not a task step: no lease, no verification, no commit.
const workspaceRoot = () => path.dirname(config.aiOfficeRoot);
const registry = new WorktreeRegistry(path.join(config.worktreesDir, '.dashboard-worktrees.json'));
const timeLimitMs = config.stepTimeLimitMinutes * 60_000;
const probe = new CliProbe();
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
}));

/** The CLI's executable, or an error with the reason it cannot run a step. */
async function usableCli(cli: TaskCli) {
  const usable = await probe.usability(cli);
  if (!usable.usable || !usable.executable) throw Object.assign(new Error(`${cli} cannot run a step: ${usable.reason}.`), { status: 400 });
  return usable.executable;
}

/** Starts one sandboxed step of `cli` with the prompt on stdin; throws with the reason when it cannot. */
async function startStep(input: { cli: TaskCli; envelope: StepEnvelope; prompt: string; promptLabel: string; kind: OfficeLaunch['kind']; key: string; label: string; role?: string;
  id?: string; heartbeat?: { argv: string[]; intervalMs: number } }) {
  const executable = await usableCli(input.cli);
  const envelope = { ...input.envelope, notGitRepo: !insideGitWorkTree(input.envelope.cwd) };
  prepareWorkspace(input.cli, envelope);
  const args = stepArgs(input.cli, envelope);
  return officeLauncher.start({
    kind: input.kind, key: input.key, label: input.label, cwd: input.envelope.cwd, ...(input.role ? { role: input.role } : {}),
    argv: [executable.command, ...executable.prefix, ...args], stdin: input.prompt, env: stepEnv(input.envelope.cwd),
    stream: input.cli, timeLimitMs, ...(input.id ? { id: input.id } : {}), ...(input.heartbeat ? { heartbeat: input.heartbeat } : {}),
    display: `${displayCommand(input.cli, args)} < ${input.promptLabel} on stdin  (cwd ${input.envelope.cwd})`,
  });
}

/** The knowledge run must not commit, move branches or delete files: denied on top of the envelope's git push. */
const KNOWLEDGE_DENY = ['Bash(git commit *)', 'Bash(git reset *)', 'Bash(git checkout *)', 'Bash(rm *)'];

/** One knowledge round: the weekly re-check with a brief built now; null when nothing is in scope. */
async function startKnowledgeRound(): Promise<OfficeLaunch | null> {
  const prompt = knowledgeRecheckPrompt(await knowledgeReviewService.recheckBrief('task'), workspaceRoot());
  if (!prompt) return null;
  return startStep({
    cli: 'claude', kind: 'knowledge', key: 'knowledge', label: 'Knowledge re-check', prompt, promptLabel: 'weekly re-check prompt + brief',
    envelope: { cwd: workspaceRoot(), writableDirs: [], model: KNOWLEDGE_MODEL, extraDeny: KNOWLEDGE_DENY },
  });
}

const knowledgeChain = new KnowledgeChain(officeLauncher, startKnowledgeRound, path.join(officeLauncher.dir, 'knowledge-chain.json'));
// Advances a multi-round re-check (also after a dashboard restart: the chain is on disk).
setInterval(() => { knowledgeChain.tick().catch((err) => console.warn('knowledge chain tick failed:', err)); }, 10_000).unref();

// Command › Operations › Running now: what is actually executing from a Start button.
// A list: the raw log and the progress lines stay on the task's launch view.
router.get('/active', (_req, res) => res.json({ launches: officeLauncher.active().map(({ log, progress, ...rest }) => rest) }));

router.get('/knowledge', (_req, res) => res.json({ launch: officeLauncher.latest('knowledge'), chain: knowledgeChain.view() }));

router.post('/knowledge', async (req, res) => {
  const rounds = Number(req.body?.rounds ?? 1);
  try {
    const { launch, chain } = await knowledgeChain.start(rounds);
    if (!launch) return res.status(409).json({ error: 'Nothing to re-check: no open findings in the approved scope and no operator answers waiting.' });
    return res.status(201).json({ launch, chain });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Launch failed.';
    return res.status(/Rounds must/.test(message) ? 400 : /brief|policy/i.test(message) ? 503 : 409).json({ error: message });
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

const buildPrompt = (taskId: string, files: TaskFiles, role: string, note: string | undefined, worktrees: PromptWorktree[], referenceOnly: string[]) => taskPrompt({
  taskId, title: files.title, role, workspaceRoot: workspaceRoot(), officeRoot: config.aiOfficeRoot, worktrees, referenceOnly, note, nextAction: files.nextAction,
});

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
  let record: StepRecord | undefined;
  try {
    // Nothing is created for a CLI that cannot run or a task already running (D8: one step at a time per task).
    await usableCli(cli as TaskCli);
    const current = officeLauncher.latest(taskId);
    if (current && ['running', 'stopping'].includes(current.status)) return res.status(409).json({ error: `${current.label} is already running (started ${current.startedAt}).` });
    if (governance.pending(taskId)) return res.status(409).json({ error: `The previous step on ${taskId} is still being verified and committed; start the next one when it is done.` });
    const model = cli === 'codex' ? CODEX_MODEL : cli === 'claude' ? CLAUDE_TASK_MODEL : undefined;
    const id = officeLauncher.newId();
    // D6/D8: the task's ownership lease first (refused with the holder and the reason),
    // held for the whole step: released after verification and the commit, or on any failure.
    record = await governance.begin({ launchId: id, taskId, role: step.role, cli: cli as TaskCli, model });
    const ctx = worktreeContext(taskId, files.taskMarkdown);
    const ensured = await ensureWorktrees(ctx, targets);
    const records = ensured.map((e) => e.record);
    const { referenceOnly } = proposeRepos(files.taskMarkdown, listRepos(workspaceRoot()));
    const prompt = buildPrompt(taskId, files, step.role, step.note, records, referenceOnly.map((r) => r.repo));
    await governance.attachWorktrees(record, records.map((r) => ({ repo: r.repo, path: r.path, branch: r.branch })), prompt);
    const launch = await startStep({
      cli: cli as TaskCli, kind: 'task', key: taskId, label: `${taskId} ${step.role}`, role: step.role, id, heartbeat: governance.heartbeat(record),
      prompt, promptLabel: `${step.role} prompt for ${taskId}`,
      envelope: runEnvelope(cli as TaskCli, records, files.runDir, model),
    });
    governance.markStarted(record);
    return res.status(201).json({ launch, lease: record.grant.message, worktrees: ensured.map((e) => ({ ...e.record, warnings: e.plan.warnings, ...(e.note ? { note: e.note } : {}) })) });
  } catch (err) {
    // The step never started: give the lease back and record why.
    if (record && !officeLauncher.get(record.launchId)) await governance.abort(record, err instanceof Error ? err.message : 'launch failed').catch((e) => console.warn('abort failed:', e));
    const e = errorBody(err, 'Launch failed.');
    return res.status(e.status).json(e.body);
  }
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
  try {
    const view = await workspaceView(taskId, files, targets);
    const worktrees = view.plans.filter((p) => p.action !== 'refuse' && p.path && p.branch).map((p) => ({ repo: p.repo, path: p.path!, branch: p.branch! }));
    return res.json({ prompt: buildPrompt(taskId, files, step.role, step.note, worktrees, view.referenceOnly.map((r) => r.repo)) });
  } catch (err) { const e = errorBody(err, 'Could not build the prompt.'); return res.status(e.status).json(e.body); }
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

router.post('/:id/stop', (req, res) => {
  try { return res.json({ launch: officeLauncher.stop(req.params.id) }); }
  catch (err) { return res.status(404).json({ error: err instanceof Error ? err.message : 'Stop failed.' }); }
});

export default router;

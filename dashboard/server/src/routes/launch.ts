import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { localOnly } from '../middleware/localOnly';
import { resolveRunDir } from '../pathSecurity';
import { knowledgeRecheckPrompt } from '../services/knowledgeRecheckPrompt';
import { displayCommand, prepareWorkspace, stepArgs, stepEnv, type StepEnvelope } from '../services/cliAdapter';
import { CliProbe } from '../services/cliProbe';
import { CLAUDE_TASK_MODEL, CODEX_MODEL, KNOWLEDGE_MODEL, officeLauncher, TASK_CLIS, TASK_ROLES, type TaskCli } from '../services/officeLauncher';
import { globalScanner } from '../services/runScanner';
import { TaskContractCache, validateYaml } from '../services/taskContract';
import { recordedNextAction, taskPrompt } from '../services/taskPrompt';
import type { OfficeLaunch, TaskLaunchResponse } from '../../../shared/types';
import { knowledgeReviewService } from './knowledgeReviews';
import { KnowledgeChain } from '../services/knowledgeChain';

const router = Router();
router.use(localOnly);

// Task steps and knowledge rounds still run from the workspace root (per-task
// worktrees come with the next slice of docs/start-task-redesign-spec.md); each runs
// inside its CLI's sandbox (cliAdapter.ts), so it can write only there and in the
// task's runs dir, with the network off.
const workspaceRoot = () => path.dirname(config.aiOfficeRoot);
const timeLimitMs = config.stepTimeLimitMinutes * 60_000;
const probe = new CliProbe();

router.get('/tools', async (_req, res) => res.json({
  clis: (await probe.all()).map(({ id, usable, reason, note, model }) => ({ id, available: usable, ...(reason ? { reason } : {}), ...(note ? { note } : {}), ...(model ? { model } : {}) })),
  roles: TASK_ROLES,
  timeLimitMinutes: config.stepTimeLimitMinutes,
}));

/** Starts one sandboxed step of `cli` with the prompt on stdin; throws with the reason when it cannot. */
async function startStep(input: { cli: TaskCli; envelope: StepEnvelope; prompt: string; promptLabel: string; kind: OfficeLaunch['kind']; key: string; label: string; role?: string }) {
  const usable = await probe.usability(input.cli);
  if (!usable.usable || !usable.executable) throw Object.assign(new Error(`${input.cli} cannot run a step: ${usable.reason}.`), { status: 400 });
  prepareWorkspace(input.cli, input.envelope);
  const args = stepArgs(input.cli, input.envelope);
  return officeLauncher.start({
    kind: input.kind, key: input.key, label: input.label, cwd: input.envelope.cwd, ...(input.role ? { role: input.role } : {}),
    argv: [usable.executable.command, ...usable.executable.prefix, ...args], stdin: input.prompt, env: stepEnv(input.envelope.cwd),
    stream: input.cli, timeLimitMs,
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

const contracts = new TaskContractCache();

router.get('/task/:taskId', async (req, res) => {
  const dir = resolveRunDir(config.runsDir, req.params.taskId);
  if (!dir.ok) return res.status(dir.code).json({ error: dir.error });
  const launch = officeLauncher.latest(req.params.taskId);
  const body: TaskLaunchResponse = { launch };
  try { body.statusChangedAt = (await fs.stat(path.join(dir.runDir, 'status.yaml'))).mtime.toISOString(); } catch { /* no status yet */ }
  if (launch?.role && !['running', 'stopping'].includes(launch.status)) {
    body.contract = await contracts.get(launch, dir.runDir, validateYaml(config.aiOfficeRoot));
  }
  return res.json(body);
});

/** The step prompt from the task's own files, or why there is none. */
async function stepPrompt(taskId: string, body: unknown): Promise<{ prompt: string; role: string; runDir: string } | { status: number; error: string }> {
  const dir = resolveRunDir(config.runsDir, taskId);
  if (!dir.ok) return { status: dir.code, error: dir.error };
  const { role, note } = (body ?? {}) as { role?: unknown; note?: unknown };
  if (!(TASK_ROLES as readonly string[]).includes(String(role))) return { status: 400, error: `Role must be one of ${TASK_ROLES.join(', ')}.` };
  if (typeof note !== 'undefined' && (typeof note !== 'string' || note.length > 4000)) return { status: 400, error: 'Note must be text of at most 4,000 characters.' };
  const detail = await globalScanner.getRunDetail(taskId);
  if (!detail?.taskMarkdown) return { status: 404, error: 'Task not found.' };
  return { role: String(role), runDir: dir.runDir, prompt: taskPrompt({
    taskId, title: detail.title, role: String(role), workspaceRoot: workspaceRoot(), note, nextAction: recordedNextAction(detail.statusRaw),
  }) };
}

router.post('/task/:taskId', async (req, res) => {
  const { taskId } = req.params;
  const step = await stepPrompt(taskId, req.body);
  if ('error' in step) return res.status(step.status).json({ error: step.error });
  const cli = String(req.body?.cli);
  if (!(TASK_CLIS as readonly string[]).includes(cli)) return res.status(400).json({ error: `CLI must be one of ${TASK_CLIS.join(', ')}.` });
  try {
    const launch = await startStep({
      cli: cli as TaskCli, kind: 'task', key: taskId, label: `${taskId} ${step.role}`, role: step.role, prompt: step.prompt,
      promptLabel: `${step.role} prompt for ${taskId}`,
      // trustWorkspace stays off: cursor-agent --trust only on a dashboard-created worktree (D3/D10).
      envelope: { cwd: workspaceRoot(), writableDirs: [step.runDir], model: cli === 'codex' ? CODEX_MODEL : cli === 'claude' ? CLAUDE_TASK_MODEL : undefined },
    });
    return res.status(201).json({ launch });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 409;
    return res.status(status).json({ error: err instanceof Error ? err.message : 'Launch failed.' });
  }
});

// The exact prompt a Start would send, for review before starting.
router.post('/task/:taskId/prompt', async (req, res) => {
  const step = await stepPrompt(req.params.taskId, req.body);
  if ('error' in step) return res.status(step.status).json({ error: step.error });
  return res.json({ prompt: step.prompt });
});

router.post('/:id/stop', (req, res) => {
  try { return res.json({ launch: officeLauncher.stop(req.params.id) }); }
  catch (err) { return res.status(404).json({ error: err instanceof Error ? err.message : 'Stop failed.' }); }
});

export default router;

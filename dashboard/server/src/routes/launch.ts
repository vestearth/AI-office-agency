import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { localOnly } from '../middleware/localOnly';
import { resolveRunDir } from '../pathSecurity';
import { knowledgeRecheckPrompt } from '../services/knowledgeRecheckPrompt';
import { CODEX_MODEL, findOnPath, knowledgeLaunchArgs, KNOWLEDGE_MODEL, officeLauncher, TASK_CLIS, TASK_ROLES, taskCliArgs } from '../services/officeLauncher';
import { globalScanner } from '../services/runScanner';
import { TaskContractCache, validateYaml } from '../services/taskContract';
import { recordedNextAction, taskPrompt } from '../services/taskPrompt';
import type { OfficeLaunch, TaskLaunchResponse } from '../../../shared/types';
import { knowledgeReviewService } from './knowledgeReviews';
import { KnowledgeChain } from '../services/knowledgeChain';

const router = Router();
router.use(localOnly);

const workspaceRoot = () => path.dirname(config.aiOfficeRoot);

router.get('/tools', (_req, res) => res.json({
  clis: TASK_CLIS.map((id) => ({ id, available: Boolean(findOnPath(id)) })),
  roles: TASK_ROLES,
}));

/** One knowledge round: the weekly re-check with a brief built now; null when nothing is in scope. */
async function startKnowledgeRound(): Promise<OfficeLaunch | null> {
  const claude = findOnPath('claude');
  if (!claude) throw new Error('Claude Code CLI is not on the dashboard server PATH.');
  const prompt = knowledgeRecheckPrompt(await knowledgeReviewService.recheckBrief('task'), workspaceRoot());
  if (!prompt) return null;
  return officeLauncher.start({
    kind: 'knowledge', key: 'knowledge', label: 'Knowledge re-check', cwd: workspaceRoot(),
    argv: knowledgeLaunchArgs(claude, prompt),
    display: `claude -p <weekly re-check prompt + brief> --model ${KNOWLEDGE_MODEL} --permission-mode acceptEdits (git commit/push refused)`,
  });
}

const knowledgeChain = new KnowledgeChain(officeLauncher, startKnowledgeRound, path.join(officeLauncher.dir, 'knowledge-chain.json'));
// Advances a multi-round re-check (also after a dashboard restart: the chain is on disk).
setInterval(() => { knowledgeChain.tick().catch((err) => console.warn('knowledge chain tick failed:', err)); }, 10_000).unref();

// Command › Operations › Running now: what is actually executing from a Start button.
router.get('/active', (_req, res) => res.json({ launches: officeLauncher.active().map(({ log, ...rest }) => rest) }));

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
async function stepPrompt(taskId: string, body: unknown): Promise<{ prompt: string; role: string } | { status: number; error: string }> {
  const dir = resolveRunDir(config.runsDir, taskId);
  if (!dir.ok) return { status: dir.code, error: dir.error };
  const { role, note } = (body ?? {}) as { role?: unknown; note?: unknown };
  if (!(TASK_ROLES as readonly string[]).includes(String(role))) return { status: 400, error: `Role must be one of ${TASK_ROLES.join(', ')}.` };
  if (typeof note !== 'undefined' && (typeof note !== 'string' || note.length > 4000)) return { status: 400, error: 'Note must be text of at most 4,000 characters.' };
  const detail = await globalScanner.getRunDetail(taskId);
  if (!detail?.taskMarkdown) return { status: 404, error: 'Task not found.' };
  return { role: String(role), prompt: taskPrompt({
    taskId, title: detail.title, role: String(role), workspaceRoot: workspaceRoot(), note, nextAction: recordedNextAction(detail.statusRaw),
  }) };
}

router.post('/task/:taskId', async (req, res) => {
  const { taskId } = req.params;
  const step = await stepPrompt(taskId, req.body);
  if ('error' in step) return res.status(step.status).json({ error: step.error });
  const cli = String(req.body?.cli);
  let argv: string[];
  const executable = findOnPath(cli);
  try { argv = taskCliArgs(cli, executable ?? { command: cli, prefix: [] }, step.prompt); }
  catch (err) { return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid CLI.' }); }
  if (!executable) return res.status(400).json({ error: `${cli} is not on the dashboard server PATH.` });
  try {
    const launch = officeLauncher.start({
      kind: 'task', key: taskId, label: `${taskId} ${step.role}`, cwd: workspaceRoot(), argv, role: step.role,
      display: `${cli}${cli === 'codex' ? ` -m ${CODEX_MODEL}` : ''} <${step.role} prompt for ${taskId}>  (cwd ${workspaceRoot()})`,
    });
    return res.status(201).json({ launch });
  } catch (err) { return res.status(409).json({ error: err instanceof Error ? err.message : 'Launch failed.' }); }
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

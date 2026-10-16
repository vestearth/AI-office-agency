import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { localOnly } from '../middleware/localOnly';
import { resolveRunDir } from '../pathSecurity';
import { knowledgeRecheckPrompt } from '../services/knowledgeRecheckPrompt';
import { findOnPath, knowledgeLaunchArgs, KNOWLEDGE_MODEL, officeLauncher, TASK_CLIS, TASK_ROLES, taskCliArgs } from '../services/officeLauncher';
import { globalScanner } from '../services/runScanner';
import { TaskContractCache, validateYaml } from '../services/taskContract';
import { recordedNextAction, taskPrompt } from '../services/taskPrompt';
import type { TaskLaunchResponse } from '../../../shared/types';
import { knowledgeReviewService } from './knowledgeReviews';

const router = Router();
router.use(localOnly);

const workspaceRoot = () => path.dirname(config.aiOfficeRoot);

router.get('/tools', (_req, res) => res.json({
  clis: TASK_CLIS.map((id) => ({ id, available: Boolean(findOnPath(id)) })),
  roles: TASK_ROLES,
}));

router.get('/knowledge', (_req, res) => res.json({ launch: officeLauncher.latest('knowledge') }));

router.post('/knowledge', async (_req, res) => {
  const claude = findOnPath('claude');
  if (!claude) return res.status(400).json({ error: 'Claude Code CLI is not on the dashboard server PATH.' });
  let prompt: string | null;
  try { prompt = knowledgeRecheckPrompt(await knowledgeReviewService.recheckBrief('task'), workspaceRoot()); }
  catch (err) { return res.status(503).json({ error: `Could not build the re-check brief: ${err instanceof Error ? err.message : String(err)}` }); }
  if (!prompt) return res.status(409).json({ error: 'Nothing to re-check: no open findings in the approved scope and no operator answers waiting.' });
  try {
    const launch = officeLauncher.start({
      kind: 'knowledge', key: 'knowledge', label: 'Knowledge re-check', cwd: workspaceRoot(),
      argv: knowledgeLaunchArgs(claude, prompt),
      display: `claude -p <weekly re-check prompt + brief> --model ${KNOWLEDGE_MODEL} --permission-mode acceptEdits (git commit/push refused)`,
    });
    return res.status(201).json({ launch });
  } catch (err) { return res.status(409).json({ error: err instanceof Error ? err.message : 'Launch failed.' }); }
});

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
  try { argv = taskCliArgs(cli, executable ?? cli, step.prompt); }
  catch (err) { return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid CLI.' }); }
  if (!executable) return res.status(400).json({ error: `${cli} is not on the dashboard server PATH.` });
  try {
    const launch = officeLauncher.start({
      kind: 'task', key: taskId, label: `${taskId} ${step.role}`, cwd: workspaceRoot(), argv, role: step.role,
      display: `${cli} <${step.role} prompt for ${taskId}>  (cwd ${workspaceRoot()})`,
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

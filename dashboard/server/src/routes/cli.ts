import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { resolveRunDir } from '../pathSecurity';
import { cliRunner, codexArgs } from '../services/cliRunner';

const router = Router();
// Executing a local agent is stronger than a read model. Reject remote callers,
// DNS rebinding, and cross-origin writes even when dashboard auth is disabled.
router.use((req, res, next) => {
  const peer = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer || '') || !['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) {
    return res.status(403).json({ error: 'CLI execution is available only on localhost.' });
  }
  if (req.method === 'POST' && ![...config.allowedOrigins, `http://localhost:${config.port}`].includes(req.get('origin') || '')) {
    return res.status(403).json({ error: 'CLI writes require an allowed dashboard Origin.' });
  }
  next();
});

router.get('/tools', (_req, res) => res.json({ tools: [
  { id: 'codex', available: cliRunner.available(), command: 'codex exec', args: codexArgs('read-only') },
  { id: 'claude', available: false, command: null },
  { id: 'cursor', available: false, command: null },
] }));

router.get('/:taskId', (req, res) => res.json({ run: cliRunner.latest(req.params.taskId) }));

router.post('/:taskId', async (req, res) => {
  const body = req.body ?? {};
  if (body.cli !== 'codex' || typeof body.workspace !== 'string' || !path.isAbsolute(body.workspace) ||
      !['read-only', 'workspace-write'].includes(body.sandbox) || typeof body.prompt !== 'string' ||
      !body.prompt.trim() || body.prompt.length > 50000) return res.status(400).json({ error: 'Invalid CLI, absolute workspace, sandbox, or prompt (maximum 50,000 characters).' });
  const dir = resolveRunDir(config.runsDir, req.params.taskId);
  if (!dir.ok) return res.status(dir.code).json({ error: dir.error });
  try { await fs.access(path.join(dir.runDir, 'task.md')); }
  catch { return res.status(404).json({ error: 'Task not found.' }); }
  try {
    let workspace: string;
    try { workspace = await fs.realpath(body.workspace); }
    catch { throw new Error('Target workspace does not exist on the dashboard server. Enter the actual repository path.'); }
    if (!(await fs.stat(workspace)).isDirectory()) throw new Error('Workspace is not a directory.');
    // Keep Codex's own git check enabled, and catch the common wrong-path case.
    let gitRoot = workspace;
    while (true) {
      try { await fs.access(path.join(gitRoot, '.git')); break; } catch {
        const parent = path.dirname(gitRoot);
        if (parent === gitRoot) throw new Error('Workspace must belong to a Git repository.');
        gitRoot = parent;
      }
    }
    if (['running', 'stopping'].includes(cliRunner.latest(req.params.taskId)?.status || '')) return res.status(409).json({ error: 'This task already has an active CLI run.' });
    const run = cliRunner.start(req.params.taskId, workspace, body.sandbox, body.prompt);
    return res.status(201).json({ run });
  } catch (err) { return res.status(400).json({ error: err instanceof Error ? err.message : 'CLI launch failed.' }); }
});

router.post('/:taskId/stop', (req, res) => {
  try {
    if (typeof req.body?.id !== 'string') return res.status(400).json({ error: 'Run id is required.' });
    return res.json({ run: cliRunner.stop(req.params.taskId, req.body.id) });
  } catch (err) { return res.status(409).json({ error: err instanceof Error ? err.message : 'Stop failed.' }); }
});

export default router;

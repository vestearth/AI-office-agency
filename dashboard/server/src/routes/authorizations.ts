import { Router } from 'express';
import fs from 'fs/promises';
import { config } from '../config';
import { localOnly } from '../middleware/localOnly';
import { resolveRunDir } from '../pathSecurity';
import { globalAuthorizationGrants } from '../services/authorizationGrants';
import { globalReviewModel } from '../services/reviewModel';

// Issue #56: grants from the Action Center. A grant authorizes a deploy, so like a
// task step it is accepted only from this machine (localOnly), behind the shared
// token when one is set; services/authorizationGrants.ts decides who it is recorded as.
const router = Router();
router.use(localOnly);

router.use('/:taskId', async (req, res, next) => {
  const dir = resolveRunDir(config.runsDir, req.params.taskId);
  if (!dir.ok) return res.status(dir.code).json({ error: dir.error });
  try {
    await fs.access(dir.runDir);
  } catch {
    return res.status(404).json({ error: 'Run not found' });
  }
  return next();
});

// What the task's gates wait for, and who a grant would be recorded as.
router.get('/:taskId', async (req, res) => res.json(await globalAuthorizationGrants.view(req.params.taskId)));

router.post('/:taskId/grant', async (req, res) => {
  const result = await globalAuthorizationGrants.record(req.params.taskId, req.body ?? {});
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  globalReviewModel.invalidate();
  const { ok: _ok, ...grant } = result;
  return res.status(201).json(grant);
});

export default router;

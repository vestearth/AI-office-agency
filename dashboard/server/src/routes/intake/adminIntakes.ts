import { Router } from 'express';
import type { DB } from '../../intake/db';
import { getIntake } from '../../intake/intakeStore';
import { makeAdminAuth } from '../../middleware/adminAuth';
import { intakeConfig } from '../../intake/config';

// Admin detail endpoint (M4 Task 6): returns the FULL IntakeRow, not the
// tester-facing projection — admin capability sees everything. Guarded by
// intake:read (read-only), not intake:admin.
export function buildAdminIntakesRouter(db: DB): Router {
  const router = Router({ mergeParams: true });
  router.use(makeAdminAuth(db, { mode: intakeConfig.adminAuthMode, requiredCapability: 'intake:read' }));
  router.get('/:id', (req, res) => {
    const row = getIntake(db, (req.params as any).id as string);
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(row);
  });
  return router;
}

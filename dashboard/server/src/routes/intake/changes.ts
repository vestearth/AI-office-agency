import { Router } from 'express';
import type { DB } from '../../intake/db';
import { listChangesSince } from '../../intake/changesStore';
import { intakeConfig } from '../../intake/config';
import { makeAdminAuth } from '../../middleware/adminAuth';

// `adminToken` is kept as a parameter only to avoid breaking call sites; it
// is unused for admin routing post-M3 (see buildAdminRouter for the same note).
export function buildChangesRouter(db: DB, adminToken: string | undefined): Router {
  const router = Router();
  router.use(makeAdminAuth(db, { mode: intakeConfig.adminAuthMode, requiredCapability: 'intake:read' })); // Local pulls with the admin credential
  router.get('/', (req, res) => {
    const since = Number.parseInt(String(req.query.since ?? '0'), 10);
    const limit = Math.min(Number.parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
    const cursor = Number.isFinite(since) && since >= 0 ? since : 0;
    res.json(listChangesSince(db, cursor, limit)); // read-only (Decision #14)
  });
  return router;
}

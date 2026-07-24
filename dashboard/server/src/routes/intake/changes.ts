import { Router } from 'express';
import type { DB } from '../../intake/db';
import { listChangesSince } from '../../intake/changesStore';
import { createAuthMiddleware } from '../../middleware/auth';

export function buildChangesRouter(db: DB, adminToken: string | undefined): Router {
  const router = Router();
  router.use(createAuthMiddleware(adminToken)); // Local pulls with the admin credential
  router.get('/', (req, res) => {
    const since = Number.parseInt(String(req.query.since ?? '0'), 10);
    const limit = Math.min(Number.parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
    const cursor = Number.isFinite(since) && since >= 0 ? since : 0;
    res.json(listChangesSince(db, cursor, limit)); // read-only (Decision #14)
  });
  return router;
}

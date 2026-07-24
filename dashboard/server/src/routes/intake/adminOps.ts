import { Router } from 'express';
import type { DB } from '../../intake/db';
import type { WindowLimiter } from '../../intake/rateLimiter';
import { intakeConfig } from '../../intake/config';
import { makeAdminAuth } from '../../middleware/adminAuth';

// Admin-only visibility into currently-throttled sessions (Milestone 3 Task
// 4). Reads the SAME limiter instances the auth/intakes routes hit, so this
// reports live state rather than a snapshot from a separately-constructed
// limiter.
export function buildAdminOpsRouter(
  db: DB,
  opts: { codeExchangeLimiter: WindowLimiter; submissionLimiter: WindowLimiter }
): Router {
  const router = Router();
  router.use(makeAdminAuth(db, { mode: intakeConfig.adminAuthMode, requiredCapability: 'intake:admin' }));

  router.get('/throttled', (_req, res) => {
    const now = Date.now();
    res.json({
      codeExchange: opts.codeExchangeLimiter.throttledKeys(now),
      submission: opts.submissionLimiter.throttledKeys(now),
    });
  });

  return router;
}

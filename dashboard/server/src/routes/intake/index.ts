import type { Express } from 'express';
import { json } from 'express';
import type { DB } from '../../intake/db';
import { getDb } from '../../intake/db';
import { makeRequireTesterSession } from '../../middleware/testerSession';
import { makeCsrfGuard } from '../../middleware/csrf';
import { WindowLimiter } from '../../intake/rateLimiter';
import { intakeConfig } from '../../intake/config';
import { buildAuthRouter } from './auth';
import { buildIntakesRouter } from './intakes';
import { buildAttachmentsRouter } from './attachments';
import { buildAdminRouter } from './admin';
import { buildAdminIntakesRouter } from './adminIntakes';
import { buildChangesRouter } from './changes';
import { buildClaimRouter } from './claim';
import { buildTriageRouter } from './triage';
import { buildPromotionRouter } from './promotion';
import { buildAdminOpsRouter } from './adminOps';
import { buildProductsRouter } from './products';

// Minimal cookie parser (avoids adding cookie-parser dependency).
function cookieParser(req: any, _res: any, next: any) {
  const header = req.headers.cookie;
  req.cookies = {};
  if (typeof header === 'string') {
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > -1) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  next();
}

export function mountIntakeRoutes(
  app: Express,
  opts: { db?: DB; allowedOrigins: string[]; adminToken: string | undefined }
): void {
  const db = opts.db ?? getDb();
  if (!db) {
    return;
  }

  const requireSession = makeRequireTesterSession(() => db);
  const csrf = makeCsrfGuard({ allowedOrigins: opts.allowedOrigins });

  // Constructed once here (not inside the routers) so the admin throttled-
  // sessions endpoint reports on the SAME limiter instances the auth/intakes
  // routes hit, not an independent snapshot. Each router still defaults to
  // constructing its own limiter when none is injected, which is what keeps
  // existing per-test router construction isolated (M3 Task 4).
  const codeExchangeLimiter = new WindowLimiter(intakeConfig.codeExchange);
  const submissionLimiter = new WindowLimiter({
    windowMs: intakeConfig.submission.windowMs,
    maxAttempts: intakeConfig.submission.maxPerWindow,
  });

  app.use('/api/intake', cookieParser);

  // Admin intake-detail (Task 6): admin-bearer-guarded (intake:read), FULL
  // row (not the tester projection). Mount before the broader
  // /api/intake/admin router below so /admin/intakes/:id isn't shadowed.
  app.use('/api/intake/admin/intakes', buildAdminIntakesRouter(db));

  // Admin uses bearer token, not tester session — mount first.
  app.use('/api/intake/admin', json(), buildAdminRouter(db, opts.adminToken));

  // Admin visibility into throttled sessions — admin-bearer-guarded, mounted
  // alongside the other admin routes, before the tester-session routes below.
  app.use('/api/intake/admin', json(), buildAdminOpsRouter(db, { codeExchangeLimiter, submissionLimiter }));

  // Changes feed: admin-bearer-guarded, read-only cursor pull (Decision #14).
  app.use('/api/intake/changes', buildChangesRouter(db, opts.adminToken));

  // Auth: session create is public (rate-limited), CSRF-exempt (no token yet
  // exists at that point); logout needs session + CSRF.
  app.use('/api/intake/session', json(), buildAuthRouter(db, { limiter: codeExchangeLimiter, csrf, requireSession }));

  // Claim protocol: admin-bearer-guarded (owner claims from Local), mount before
  // the tester-session-guarded routes below so it isn't shadowed by the broader
  // /api/intake/intakes prefix.
  app.use('/api/intake/intakes/:id/claim', buildClaimRouter(db, opts.adminToken));

  // Triage import/read: admin-bearer-guarded (owner imports triage results from
  // Local), mount before the tester-session-guarded routes below for the same
  // shadowing reason as claim above.
  app.use('/api/intake/intakes/:id/triage', buildTriageRouter(db, opts.adminToken));

  // Promotion relationship endpoint: admin-bearer-guarded (owner promotes an
  // intake from Local). UNIQUE(intake_id) is the idempotency backstop — see
  // promotionRecordStore. Mount before the tester-session-guarded routes
  // below for the same shadowing reason as claim/triage above.
  app.use('/api/intake/intakes/:id/promotion', buildPromotionRouter(db, opts.adminToken));

  // Product options for the tester submission UI: session-guarded read-only
  // list, no CSRF needed (GET only, no state change).
  app.use('/api/intake/products', requireSession, buildProductsRouter());

  // All remaining intake routes require a tester session + CSRF on unsafe methods.
  app.use('/api/intake/intakes/:id/attachments', requireSession, csrf, buildAttachmentsRouter(db));
  app.use('/api/intake/intakes', requireSession, csrf, json(), buildIntakesRouter(db, { limiter: submissionLimiter }));
}

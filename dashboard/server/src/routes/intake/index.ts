import type { Express } from 'express';
import { json } from 'express';
import type { DB } from '../../intake/db';
import { getDb } from '../../intake/db';
import { makeRequireTesterSession } from '../../middleware/testerSession';
import { makeCsrfGuard } from '../../middleware/csrf';
import { buildAuthRouter } from './auth';
import { buildIntakesRouter } from './intakes';
import { buildAttachmentsRouter } from './attachments';
import { buildAdminRouter } from './admin';

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
  const requireSession = makeRequireTesterSession(() => db);
  const csrf = makeCsrfGuard({ allowedOrigins: opts.allowedOrigins });

  app.use('/api/intake', cookieParser);

  // Admin uses bearer token, not tester session — mount first.
  app.use('/api/intake/admin', json(), buildAdminRouter(db, opts.adminToken));

  // Auth: session create is public (rate-limited); logout needs session.
  app.use('/api/intake/session', json(), buildAuthRouter(db));

  // All remaining intake routes require a tester session + CSRF on unsafe methods.
  app.use('/api/intake/intakes/:id/attachments', requireSession, csrf, buildAttachmentsRouter(db));
  app.use('/api/intake/intakes', requireSession, csrf, json(), buildIntakesRouter(db));
}

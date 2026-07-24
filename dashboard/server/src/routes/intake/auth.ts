import { Router } from 'express';
import type { DB } from '../../intake/db';
import { verifyAccessCode } from '../../intake/accessCodeStore';
import { createSession, revokeSession } from '../../intake/sessionStore';
import { recordAudit } from '../../intake/audit';
import { WindowLimiter } from '../../intake/rateLimiter';
import { intakeConfig } from '../../intake/config';
import { requireTesterSession } from '../../middleware/testerSession';

export function buildAuthRouter(db: DB, opts: { limiter?: WindowLimiter } = {}): Router {
  const router = Router();
  const limiter = opts.limiter ?? new WindowLimiter(intakeConfig.codeExchange);

  router.post('/', (req, res) => {
    const key = req.ip || 'unknown';
    const gate = limiter.hit(key, Date.now());
    if (!gate.allowed) {
      recordAudit(db, { kind: 'code_exchange_throttled', actorKind: 'system', detail: { key, attempts: gate.attempts } });
      res.setHeader('Retry-After', Math.ceil(gate.retryAfterMs / 1000));
      res.status(429).json({ error: 'Too many attempts' });
      return;
    }
    const code = (req.body?.code ?? '').toString();
    const result = verifyAccessCode(db, code);
    if (!result.ok) {
      recordAudit(db, { kind: 'code_exchange_failed', actorKind: 'system', detail: { key } });
      res.status(401).json({ error: 'Invalid code' }); // generic, no enumeration
      return;
    }
    limiter.reset(key);
    const session = createSession(db, result.testerId, Date.now());
    recordAudit(db, { kind: 'session_created', actorKind: 'tester', actorId: result.testerId });
    res.cookie('intake_sid', session.sessionId, {
      httpOnly: true, secure: true, sameSite: 'strict', maxAge: intakeConfig.sessionTtlMs, path: '/api/intake',
    });
    res.status(200).json({ csrfToken: session.csrfToken, expiresAt: session.expiresAt });
  });

  router.delete('/', requireTesterSession, (req, res) => {
    revokeSession(db, req.tester!.sessionId);
    res.clearCookie('intake_sid', { path: '/api/intake' });
    res.status(204).end();
  });

  return router;
}

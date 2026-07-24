import type { Request, Response, NextFunction } from 'express';
import type { DB } from '../intake/db';
import { verifyAdminSecret } from '../intake/adminCredentialStore';

export function makeAdminAuth(
  db: DB, opts: { mode: 'required' | 'disabled'; requiredCapability?: string }
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (opts.mode === 'disabled') { next(); return; } // local dev ONLY; never in the LAN deployment

    // Header only — never a query-string token (avoids the secret landing in proxy logs/URLs).
    const header = req.headers.authorization;
    const secret = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    const anyConfigured = (db.prepare('SELECT COUNT(*) AS n FROM admin_credential WHERE revoked_at IS NULL').get() as any).n > 0;
    if (!anyConfigured) { res.status(503).json({ error: 'admin auth not provisioned' }); return; } // hard-fail, never open

    if (!secret) { res.status(401).json({ error: 'admin credential required' }); return; }
    const v = verifyAdminSecret(db, secret);
    if (!v.ok) { res.status(401).json({ error: 'invalid admin credential' }); return; }
    if (opts.requiredCapability && !v.capabilities.includes(opts.requiredCapability)) {
      res.status(403).json({ error: 'insufficient capability' }); return;
    }
    (req as any).admin = { id: v.id, capabilities: v.capabilities };
    next();
  };
}

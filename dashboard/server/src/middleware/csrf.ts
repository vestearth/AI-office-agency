import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const OK_FETCH_SITE = new Set(['same-origin', 'same-site', 'none']);

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function originOf(req: Request): string | null {
  const o = req.headers.origin;
  if (typeof o === 'string' && o) return o;
  const ref = req.headers.referer;
  if (typeof ref === 'string' && ref) {
    try { return new URL(ref).origin; } catch { return null; }
  }
  return null;
}

export function makeCsrfGuard(opts: { allowedOrigins: string[] }) {
  const allowed = new Set(opts.allowedOrigins);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE.has(req.method)) { next(); return; }

    const fetchSite = req.headers['sec-fetch-site'];
    if (typeof fetchSite === 'string' && !OK_FETCH_SITE.has(fetchSite)) {
      res.status(403).json({ error: 'Cross-site request rejected' }); return;
    }
    const origin = originOf(req);
    if (!origin || !allowed.has(origin)) {
      res.status(403).json({ error: 'Origin not allowed' }); return;
    }
    const token = req.headers['x-csrf-token'];
    // Cast avoids depending on the Express.Request augmentation module being
    // part of ts-node's on-demand compile graph for this file in isolation
    // (the augmentation lives in testerSession.ts, Task 7).
    const expected = (req as any).tester?.csrfToken;
    if (!expected || typeof token !== 'string' || !safeEqual(token, expected)) {
      res.status(403).json({ error: 'Invalid CSRF token' }); return;
    }
    next();
  };
}

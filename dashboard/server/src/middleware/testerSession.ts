import type { Request, Response, NextFunction } from 'express';
import type { DB } from '../intake/db';
import { getDb } from '../intake/db';
import { getValidSession } from '../intake/sessionStore';

export interface TesterContext { id: string; sessionId: string; csrfToken: string; }
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { tester?: TesterContext; } }
}

// Cookie parsing is minimal here to avoid a new dependency; index.ts adds a
// tiny cookie parser (Task 11) so req.cookies is populated.
export function makeRequireTesterSession(dbFn: () => DB) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const sid = (req as any).cookies?.intake_sid;
    if (!sid || typeof sid !== 'string') {
      res.status(401).json({ error: 'No session' });
      return;
    }
    const session = getValidSession(dbFn(), sid, Date.now());
    if (!session) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }
    req.tester = { id: session.testerId, sessionId: sid, csrfToken: session.csrfToken };
    next();
  };
}

export const requireTesterSession = makeRequireTesterSession(getDb);

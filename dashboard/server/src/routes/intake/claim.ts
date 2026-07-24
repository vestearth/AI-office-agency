import { Router } from 'express';
import { json } from 'express';
import type { DB } from '../../intake/db';
import { claimIntake, renewClaim, releaseClaim } from '../../intake/claimStore';
import { intakeConfig } from '../../intake/config';
import { makeAdminAuth } from '../../middleware/adminAuth';

const REASON_STATUS: Record<string, number> = { not_found: 404, revision_conflict: 409, already_claimed: 409 };

// `adminToken` is kept as a parameter only to avoid breaking call sites; it
// is unused for admin routing post-M3 (see buildAdminRouter for the same note).
export function buildClaimRouter(db: DB, adminToken: string | undefined): Router {
  const router = Router({ mergeParams: true });
  router.use(makeAdminAuth(db, { mode: intakeConfig.adminAuthMode, requiredCapability: 'intake:claim' }), json());
  router.post('/', (req, res) => {
    // Cast avoids mergeParams' inferred params type, which TS narrows to `{}`
    // for a router mounted at a parameterized parent path with its own '/'
    // route (see attachments.ts for the same pattern).
    const intakeId = (req.params as any).id as string;
    const r = claimIntake(db, {
      intakeId, owner: String(req.body?.owner ?? '').trim(),
      expectedRevision: Number(req.body?.expectedRevision), now: Date.now(), ttlMs: intakeConfig.claimTtlMs,
    });
    if (!r.ok) { res.status(REASON_STATUS[r.reason]).json({ error: r.reason }); return; }
    res.status(201).json(r.claim);
  });
  router.post('/renew', (req, res) => {
    const r = renewClaim(db, { claimId: String(req.body?.claimId), owner: String(req.body?.owner ?? '').trim(), now: Date.now(), ttlMs: intakeConfig.claimTtlMs });
    res.status(r.ok ? 200 : 409).json(r);
  });
  router.post('/release', (req, res) => {
    const r = releaseClaim(db, { claimId: String(req.body?.claimId), owner: String(req.body?.owner ?? '').trim() });
    res.status(r.ok ? 200 : 409).json(r);
  });
  return router;
}

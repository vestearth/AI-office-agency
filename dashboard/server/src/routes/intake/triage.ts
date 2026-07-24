import { Router, json } from 'express';
import type { DB } from '../../intake/db';
import { importTriageResult, getLatestTriage } from '../../intake/triageStore';
import { createAuthMiddleware } from '../../middleware/auth';

const REASON_STATUS: Record<string, number> = { not_found: 404, revision_conflict: 409, schema_invalid: 400 };

export function buildTriageRouter(db: DB, adminToken: string | undefined): Router {
  const router = Router({ mergeParams: true });
  router.use(createAuthMiddleware(adminToken), json({ limit: '256kb' }));
  router.post('/', (req, res) => {
    // Cast avoids mergeParams' inferred params type, which TS narrows to `{}`
    // for a router mounted at a parameterized parent path with its own '/'
    // route (see attachments.ts / claim.ts for the same pattern).
    const intakeId = (req.params as any).id as string;
    const r = importTriageResult(db, {
      intakeId, expectedRevision: Number(req.body?.expectedRevision),
      raw: req.body?.result, importer: String(req.body?.importer ?? '').trim(),
      repoProvenance: req.body?.repoProvenance, gateOverridden: !!req.body?.gateOverridden,
    });
    if (!r.ok) { res.status(REASON_STATUS[r.reason]).json({ error: r.reason, errors: (r as any).errors }); return; }
    res.status(201).json(r);
  });
  router.get('/', (req, res) => {
    const intakeId = (req.params as any).id as string;
    res.json(getLatestTriage(db, intakeId) ?? {});
  });
  return router;
}

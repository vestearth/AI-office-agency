import { Router, json } from 'express';
import type { DB } from '../../intake/db';
import { recordPromotion } from '../../intake/promotionRecordStore';
import { intakeConfig } from '../../intake/config';
import { makeAdminAuth } from '../../middleware/adminAuth';

// `adminToken` is kept as a parameter only to avoid breaking call sites; it
// is unused for admin routing post-M3 (see buildAdminRouter for the same note).
export function buildPromotionRouter(db: DB, adminToken: string | undefined): Router {
  const router = Router({ mergeParams: true });
  router.use(makeAdminAuth(db, { mode: intakeConfig.adminAuthMode, requiredCapability: 'intake:promote' }), json({ limit: '256kb' }));
  router.post('/', (req, res) => {
    const intakeId = (req.params as any).id as string;
    const r = recordPromotion(db, {
      intakeId, taskId: String(req.body?.taskId ?? '').trim(),
      projectionVersion: String(req.body?.projectionVersion ?? '').trim(), gateOverridden: !!req.body?.gateOverridden,
    });
    res.status(r.created ? 201 : 200).json(r);
  });
  return router;
}

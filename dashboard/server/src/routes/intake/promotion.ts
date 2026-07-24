import { Router, json } from 'express';
import type { DB } from '../../intake/db';
import { recordPromotion } from '../../intake/promotionRecordStore';
import { createAuthMiddleware } from '../../middleware/auth';

export function buildPromotionRouter(db: DB, adminToken: string | undefined): Router {
  const router = Router({ mergeParams: true });
  router.use(createAuthMiddleware(adminToken), json({ limit: '256kb' }));
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

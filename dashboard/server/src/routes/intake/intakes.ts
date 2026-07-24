import { Router } from 'express';
import type { DB } from '../../intake/db';
import { submitIntake, listIntakes, getIntake } from '../../intake/intakeStore';
import { WindowLimiter } from '../../intake/rateLimiter';
import { intakeConfig } from '../../intake/config';

export function buildIntakesRouter(db: DB): Router {
  const router = Router();
  const submitLimiter = new WindowLimiter({
    windowMs: intakeConfig.submission.windowMs,
    maxAttempts: intakeConfig.submission.maxPerWindow,
  });

  router.post('/', (req, res) => {
    const testerId = req.tester!.id;
    const gate = submitLimiter.hit(testerId, Date.now());
    if (!gate.allowed) {
      res.setHeader('Retry-After', Math.ceil(gate.retryAfterMs / 1000));
      res.status(429).json({ error: 'Submission rate exceeded' });
      return;
    }
    try {
      const { intake, deduped } = submitIntake(db, {
        testerId,
        title: req.body?.title, body: req.body?.body,
        productHint: req.body?.productHint, idempotencyKey: req.body?.idempotencyKey,
      });
      res.status(deduped ? 200 : 201).json(intake);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.get('/', (req, res) => {
    res.json(listIntakes(db, { testerId: req.tester!.id }));
  });

  router.get('/:id', (req, res) => {
    const row = getIntake(db, req.params.id);
    if (!row || row.tester_id !== req.tester!.id) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(row);
  });

  return router;
}

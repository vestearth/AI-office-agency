import { Router } from 'express';
import { intakeConfig } from '../../intake/config';

export function buildProductsRouter(): Router {
  const router = Router();
  router.get('/', (_req, res) => res.json({ products: intakeConfig.intakeProductList }));
  return router;
}

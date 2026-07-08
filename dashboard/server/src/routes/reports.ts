import { Router } from 'express';
import { ReadinessService } from '../services/readiness';

const router = Router();
const service = new ReadinessService();

router.get('/readiness', async (_req, res) => {
  try {
    res.json(await service.getProjectReadiness());
  } catch (error) {
    console.error('Failed to fetch project readiness:', error);
    res.status(500).json({ error: 'Failed to fetch project readiness' });
  }
});

export default router;

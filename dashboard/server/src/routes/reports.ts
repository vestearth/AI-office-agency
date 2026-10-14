import { Router } from 'express';
import { ReleaseLadderService } from '../services/releaseLadder';

const router = Router();
const service = new ReleaseLadderService();

// Insights › Readiness: per-product release ladder from completion gates.
router.get('/release-ladder', async (_req, res) => {
  try {
    res.json(await service.get());
  } catch (error) {
    console.error('Failed to build the release ladder:', error);
    res.status(500).json({ error: 'Failed to build the release ladder' });
  }
});

export default router;

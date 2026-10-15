import { Router } from 'express';
import { globalProdSignals } from '../services/prodSignals';

const router = Router();

// Command › Attention › Production signals. ?env=prod (default) | staging; ?refresh=1 bypasses the cache.
router.get('/', async (req, res) => {
  const env = req.query.env === 'staging' ? 'staging' : 'prod';
  try {
    res.json(await globalProdSignals.get(env, req.query.refresh === '1'));
  } catch (error) {
    console.error('Failed to build production signals:', error);
    res.status(500).json({ error: 'Failed to build production signals' });
  }
});

export default router;

import { Router } from 'express';
import path from 'node:path';
import { config } from '../config';
import { KnowledgeReviewService, KNOWLEDGE_REVIEW_ID_PATTERN } from '../services/knowledgeReviews';

const router = Router();
const service = new KnowledgeReviewService(config.knowledgeReviewsDir, path.dirname(config.aiOfficeRoot));

router.get('/', async (_req, res) => {
  try {
    res.json(await service.list());
  } catch (error) {
    console.error('Failed to fetch knowledge reviews:', error);
    res.status(500).json({ error: 'Failed to fetch knowledge reviews' });
  }
});

router.get('/:reviewId', async (req, res) => {
  const { reviewId } = req.params;
  if (!KNOWLEDGE_REVIEW_ID_PATTERN.test(reviewId)) {
    res.status(400).json({ error: 'Invalid knowledge review id' });
    return;
  }

  try {
    const review = await service.getById(reviewId);
    if (!review) {
      res.status(404).json({ error: 'Knowledge review not found' });
      return;
    }
    res.json(review);
  } catch (error) {
    console.error('Failed to fetch knowledge review:', error);
    res.status(500).json({ error: 'Failed to fetch knowledge review' });
  }
});

export default router;

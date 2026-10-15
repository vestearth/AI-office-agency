import { Router, type Response } from 'express';
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

// Before '/:reviewId', which would otherwise reject 'findings' as an invalid id.
// GET ?audience=task → the weekly re-check run's scope. POST {audience:'human',
// fingerprints:[…]} → the dashboard button (the current filter travels in the
// body; 275 fingerprints in a query string overflow the header limit, 431).
async function sendBrief(res: Response, audience: 'human' | 'task', fingerprints?: string[]) {
  try {
    res.json(await service.recheckBrief(audience, fingerprints));
  } catch (error) {
    console.error('Failed to build knowledge re-check brief:', error);
    res.status(503).json({ error: `Failed to build knowledge re-check brief: ${error instanceof Error ? error.message : String(error)}` });
  }
}

router.get('/findings/brief', (req, res) => {
  void sendBrief(res, req.query.audience === 'task' ? 'task' : 'human');
});

router.post('/findings/brief', (req, res) => {
  const body = (req.body ?? {}) as { audience?: unknown; fingerprints?: unknown };
  const fingerprints = Array.isArray(body.fingerprints)
    ? body.fingerprints.filter((f): f is string => typeof f === 'string' && f.length > 0).slice(0, 5000)
    : undefined;
  void sendBrief(res, body.audience === 'task' ? 'task' : 'human', fingerprints);
});

// Knowledge › Decisions: the operator answers a human-decision finding. Writes only the
// input ledger (knowledge-reviews/decisions/human-decisions.yaml); the next re-check
// audit records the finding's status.
router.post('/findings/decisions', async (req, res) => {
  try {
    const result = await service.recordDecision(req.body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json(result.decision);
  } catch (error) {
    console.error('Failed to record knowledge decision:', error);
    res.status(500).json({ error: 'Failed to record the decision' });
  }
});

// Before '/:reviewId', which would otherwise reject 'findings' as an invalid id.
router.get('/findings', async (_req, res) => {
  try {
    res.json(await service.openFindings());
  } catch (error) {
    console.error('Failed to build open knowledge findings:', error);
    res.status(500).json({ error: 'Failed to build open knowledge findings' });
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

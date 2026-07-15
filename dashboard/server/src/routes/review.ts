import { Router } from 'express';
import { globalReviewModel } from '../services/reviewModel';
import type { ReviewModelResponse } from '@shared/types';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const reviews = await globalReviewModel.getReviewSummaries();
    const priority = {
      awaiting_review: 0,
      decision_pending: 1,
      workflow_exception: 2,
      artifact_drift: 3,
    } as const;

    // Action Center items float to the top in operator priority order.
    reviews.sort((a, b) => {
      if (a.requiresAction !== b.requiresAction) return a.requiresAction ? -1 : 1;
      if (a.actionKind && b.actionKind && a.actionKind !== b.actionKind) {
        return priority[a.actionKind] - priority[b.actionKind];
      }
      return b.taskId.localeCompare(a.taskId);
    });

    const actionCounts: ReviewModelResponse['actionCounts'] = {
      awaiting_review: 0,
      decision_pending: 0,
      workflow_exception: 0,
      artifact_drift: 0,
    };
    for (const review of reviews) {
      if (review.actionKind) actionCounts[review.actionKind] += 1;
    }

    const response: ReviewModelResponse = {
      generatedAt: new Date().toISOString(),
      total: reviews.length,
      needsReviewCount: reviews.filter((r) => r.needsReview).length,
      actionCount: reviews.filter((r) => r.requiresAction).length,
      actionCounts,
      reviews,
    };
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: 'Failed to build review model' });
  }
});

export default router;

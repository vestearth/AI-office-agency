import { Router } from 'express';
import { globalReviewModel } from '../services/reviewModel';
import type { ReviewModelResponse } from '@shared/types';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const reviews = await globalReviewModel.getReviewSummaries();
    // Phase 2F gate kinds first, in classification order; the existing kinds keep
    // their relative order.
    const priority = {
      gates_unreadable: 0,
      authorization_required: 1,
      completion_held: 2,
      awaiting_review: 3,
      decision_pending: 4,
      workflow_exception: 5,
      artifact_drift: 6,
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
      gates_unreadable: 0,
      authorization_required: 0,
      completion_held: 0,
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

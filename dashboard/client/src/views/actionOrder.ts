import type { ActionKind } from '../../../shared/types';

/** Action Center order: what a human can act on first. Attention and Monitor's landing share it. */
export const ACTION_ORDER: ActionKind[] = [
  'gates_unreadable',
  'authorization_required',
  'completion_held',
  'awaiting_review',
  'decision_pending',
  'workflow_exception',
  'artifact_drift',
  'check_due',
  'stale_work',
];

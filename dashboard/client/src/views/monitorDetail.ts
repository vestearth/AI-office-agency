import type { AgentTimelineEvent, ReviewSummary } from '../../../shared/types';

// Monitor run-detail helpers. The server sends the timeline oldest-first and
// often with date-only timestamps, so ordering reverses the server order rather
// than re-sorting by a timestamp that ties within a day.

export const TIMELINE_PREVIEW = 5;

export function timelineView(
  events: AgentTimelineEvent[],
  expanded: boolean,
  limit = TIMELINE_PREVIEW,
): { shown: AgentTimelineEvent[]; hidden: number } {
  const newestFirst = [...events].reverse();
  const shown = expanded ? newestFirst : newestFirst.slice(0, limit);
  return { shown, hidden: newestFirst.length - shown.length };
}

/** "idle 19d" when the server's stale rule flagged the run; the threshold is the server's, never re-derived here. */
export function idleLabel(review: Pick<ReviewSummary, 'idle'> | null | undefined): string | null {
  return review?.idle ? `idle ${review.idle.days}d` : null;
}

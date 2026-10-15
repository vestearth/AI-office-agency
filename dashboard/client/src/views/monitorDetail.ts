import type { AgentTimelineEvent, ReviewSummary, RunSummary } from '../../../shared/types';

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

/**
 * A history row that records metadata rather than a hand-off: gate updates
 * ("gate x: absent -> pending"), waits_on / carries writes, and rows without a
 * phase transition. Shown dimmed with a tag so hand-offs stay readable.
 */
export function metadataTag(action: string): string | null {
  const a = action.trim().replace(/^['"]|['"]$/g, '');
  if (a.startsWith('gate ')) return 'gate';
  if (a.startsWith('waits_on:')) return 'waits';
  if (a.startsWith('carries:')) return 'train';
  return a.includes('->') ? null : 'note';
}

/** "idle 19d" when the server's stale rule flagged the run; the threshold is the server's, never re-derived here. */
export function idleLabel(review: Pick<ReviewSummary, 'idle'> | null | undefined): string | null {
  return review?.idle ? `idle ${review.idle.days}d` : null;
}

export const HOME_LIMIT = 5;

/**
 * Monitor's landing lists when no run is selected: the most recently updated
 * runs of any status, and the runs the Action Center flags (longest-waiting
 * first). A launcher, not the inbox: Attention keeps the full list.
 */
export function monitorHome(runs: RunSummary[], reviews: Map<string, ReviewSummary>, limit = HOME_LIMIT): {
  recent: RunSummary[];
  waiting: { run: RunSummary; review: ReviewSummary }[];
  waitingTotal: number;
} {
  const recent = [...runs]
    .filter((run) => run.updatedAt)
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id))
    .slice(0, limit);
  const flagged = runs
    .map((run) => ({ run, review: reviews.get(run.id) }))
    .filter((x): x is { run: RunSummary; review: ReviewSummary } => Boolean(x.review?.requiresAction));
  const waiting = [...flagged]
    .sort((a, b) => (b.review.idle?.days ?? 0) - (a.review.idle?.days ?? 0)
      || (a.review.statusUpdatedAt ?? '').localeCompare(b.review.statusUpdatedAt ?? '')
      || a.run.id.localeCompare(b.run.id))
    .slice(0, limit);
  return { recent, waiting, waitingTotal: flagged.length };
}

import type { AgentTimelineEvent, ReviewSummary, RunSummary } from '../../../shared/types';
import { ACTION_ORDER } from './actionOrder';

// Monitor run-detail helpers. The server sends the timeline oldest-first and
// often with date-only timestamps, so ordering reverses the server order rather
// than re-sorting by a timestamp that ties within a day.

export const TIMELINE_PREVIEW = 5;

/**
 * Oldest first. When every row has a full timestamp the rows are ordered by time
 * (stable), because some history[] blocks were written out of order; with date-only
 * timestamps (ties within a day) the server's file order is kept.
 */
export function chronological(events: AgentTimelineEvent[]): AgentTimelineEvent[] {
  const times = events.map((e) => (e.timestamp && e.timestamp.includes('T') ? Date.parse(e.timestamp) : NaN));
  if (times.some((t) => !Number.isFinite(t))) return [...events];
  return events.map((e, i) => ({ e, i, t: times[i]! })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.e);
}

export function timelineView(
  events: AgentTimelineEvent[],
  expanded: boolean,
  limit = TIMELINE_PREVIEW,
): { shown: AgentTimelineEvent[]; hidden: number } {
  const newestFirst = chronological(events).reverse();
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

export type PreviewEntry =
  | { kind: 'event'; event: AgentTimelineEvent }
  | { kind: 'metadata'; events: AgentTimelineEvent[] };

/**
 * The collapsed timeline: newest first, consecutive metadata rows (gate updates,
 * waits_on, carries) folded into one line, and always reaching the latest hand-off
 * (EAR-402's sat at row 12 of 15 behind metadata). `limit` counts lines, not rows.
 */
export function timelinePreview(events: AgentTimelineEvent[], limit = TIMELINE_PREVIEW): { entries: PreviewEntry[]; hidden: number } {
  const isMeta = (e: AgentTimelineEvent) => { const tag = metadataTag(e.action); return tag === 'gate' || tag === 'waits' || tag === 'train'; };
  const lines: PreviewEntry[] = [];
  for (const e of chronological(events).reverse()) {
    const last = lines[lines.length - 1];
    if (isMeta(e) && last?.kind === 'metadata') last.events.push(e);
    else lines.push(isMeta(e) ? { kind: 'metadata', events: [e] } : { kind: 'event', event: e });
  }
  const firstHandoff = lines.findIndex((l) => l.kind === 'event');
  const take = Math.max(limit, firstHandoff + 1);
  const entries = lines.slice(0, take);
  const shownRows = entries.reduce((n, l) => n + (l.kind === 'event' ? 1 : l.events.length), 0);
  return { entries, hidden: events.length - shownRows };
}

/** "idle 19d" when the server's stale rule flagged the run; the threshold is the server's, never re-derived here. */
export function idleLabel(review: Pick<ReviewSummary, 'idle'> | null | undefined): string | null {
  return review?.idle ? `idle ${review.idle.days}d` : null;
}

export const HOME_LIMIT = 5;

/**
 * Monitor's landing lists when no run is selected: the most recently updated
 * runs of any status, and the runs the Action Center flags (in Attention order, then longest-waiting
 * first). A launcher, not the inbox: Attention keeps the full list.
 */
export function monitorHome(runs: RunSummary[], reviews: Map<string, ReviewSummary>, limit = HOME_LIMIT): {
  recent: RunSummary[];
  waiting: { run: RunSummary; review: ReviewSummary }[];
  waitingTotal: number;
} {
  // updated_at is often date-only; within a day the last hand-off's real time decides.
  const day = (r: RunSummary) => (r.updatedAt ?? '').slice(0, 10);
  const when = (r: RunSummary) => reviews.get(r.id)?.lastTransition?.at ?? r.updatedAt ?? '';
  const recent = [...runs]
    .filter((run) => run.updatedAt)
    .sort((a, b) => day(b).localeCompare(day(a)) || when(b).localeCompare(when(a)) || a.id.localeCompare(b.id))
    .slice(0, limit);
  const flagged = runs
    .map((run) => ({ run, review: reviews.get(run.id) }))
    .filter((x): x is { run: RunSummary; review: ReviewSummary } => Boolean(x.review?.requiresAction));
  // Same order as Attention: kind first (a grant before a stale task), then the longest wait.
  const rank = (r: ReviewSummary) => (r.actionKind ? ACTION_ORDER.indexOf(r.actionKind) : ACTION_ORDER.length);
  const waiting = [...flagged]
    .sort((a, b) => rank(a.review) - rank(b.review)
      || (b.review.idle?.days ?? 0) - (a.review.idle?.days ?? 0)
      || (a.review.statusUpdatedAt ?? '').localeCompare(b.review.statusUpdatedAt ?? '')
      || a.run.id.localeCompare(b.run.id))
    .slice(0, limit);
  return { recent, waiting, waitingTotal: flagged.length };
}

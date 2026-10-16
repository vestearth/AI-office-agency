import type { RunStatus, RunSummary } from '../../../shared/types';
import { isActiveStatus } from '../../../shared/runCounts';

// Monitor sidebar list logic: with 500+ runs the flat list needs a scope,
// a namespace filter and month grouping to stay navigable.

export type RunScope = 'active' | 'finished' | 'all';

export function runPrefix(id: string): string {
  return id.match(/^TASK-([A-Z][A-Z0-9]*)-\d+$/)?.[1] ?? 'TASK';
}

export function inScope(status: RunStatus, scope: RunScope): boolean {
  if (scope === 'active') return isActiveStatus(status);
  if (scope === 'finished') return status === 'completed' || status === 'cancelled';
  return true;
}

/** Search text with hyphens, underscores and spaces treated alike ("bank flow" finds "Bank-flow"). */
export function normalizeSearch(text: string): string {
  return text.toLowerCase().replace(/[-_\s]+/g, ' ').trim();
}

function matchesSearch(run: RunSummary, query: string): boolean {
  return !query || normalizeSearch(run.id).includes(query) || normalizeSearch(run.title).includes(query);
}

export function filterRuns(
  runs: RunSummary[],
  { scope, prefix, search }: { scope: RunScope; prefix: string | null; search: string },
): RunSummary[] {
  const query = normalizeSearch(search);
  return runs.filter((run) => inScope(run.status, scope)
    && (prefix === null || runPrefix(run.id) === prefix)
    && matchesSearch(run, query));
}

/**
 * A search narrowed by the scope can hide every match ("0 of 550" while Finished has
 * two): how many match in the other scope, so the sidebar can offer to switch.
 */
export function searchElsewhere(
  runs: RunSummary[],
  { scope, prefix, search }: { scope: RunScope; prefix: string | null; search: string },
): { scope: RunScope; count: number } | null {
  const query = normalizeSearch(search);
  if (!query || scope === 'all') return null;
  const other: RunScope = scope === 'active' ? 'finished' : 'active';
  const count = filterRuns(runs, { scope: other, prefix, search }).length;
  return count > 0 ? { scope: other, count } : null;
}

export function prefixCounts(runs: RunSummary[], scope: RunScope): Array<{ prefix: string; count: number }> {
  const counts = new Map<string, number>();
  for (const run of runs) {
    if (inScope(run.status, scope)) counts.set(runPrefix(run.id), (counts.get(runPrefix(run.id)) ?? 0) + 1);
  }
  return [...counts].map(([prefix, count]) => ({ prefix, count })).sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix));
}

function monthKey(updatedAt: string | undefined): string {
  return updatedAt?.match(/^(\d{4}-\d{2})/)?.[1] ?? 'undated';
}

export function groupByMonth(runs: RunSummary[]): Array<{ key: string; label: string; runs: RunSummary[] }> {
  const groups = new Map<string, RunSummary[]>();
  for (const run of runs) {
    const key = monthKey(run.updatedAt);
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.keys()]
    .sort((a, b) => (a === 'undated' ? 1 : b === 'undated' ? -1 : b.localeCompare(a)))
    .map((key) => ({
      key,
      label: key === 'undated'
        ? 'No update date'
        : new Date(`${key}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      runs: groups.get(key) ?? [],
    }));
}

/**
 * status.yaml updated_at is usually a bare date. Parsing it as a timestamp
 * printed a fake local time (UTC midnight, e.g. "7:00:00 AM" in Bangkok).
 */
export function formatUpdated(value: string | undefined): string {
  if (!value) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** "Oct 17, 01:54" (local) for a timestamp with a time of day; a bare date as formatUpdated shows it. */
export function formatStamp(value: string | undefined): string {
  if (!value || !value.includes('T')) return formatUpdated(value);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

/** The time the list sorts by: the last hand-off (date and time) when history has one, else updated_at. */
export function formatMoved(run: Pick<RunSummary, 'lastHandoffAt' | 'updatedAt'>): string {
  return run.lastHandoffAt ? formatStamp(run.lastHandoffAt) : formatUpdated(run.updatedAt);
}

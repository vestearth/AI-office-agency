import type { ReviewIntakeSummary, ReviewIntakeDetail } from '../../../shared/types';

export type ColumnId = 'inbox' | 'attention' | 'ready' | 'promoted';
export const COLUMNS: { id: ColumnId; label: string }[] = [
  { id: 'inbox', label: 'Inbox' }, { id: 'attention', label: 'Needs attention' },
  { id: 'ready', label: 'Ready' }, { id: 'promoted', label: 'Promoted' },
];
const MAP: Record<string, ColumnId> = {
  submitted: 'inbox', needs_scope_review: 'attention', ai_failed: 'attention',
  triaged: 'ready', promoted: 'promoted',
};
export function columnForState(state: string): ColumnId | null { return MAP[state] ?? null; }

export function groupIntoColumns(intakes: ReviewIntakeSummary[]): Record<ColumnId, ReviewIntakeSummary[]> {
  const g: Record<ColumnId, ReviewIntakeSummary[]> = { inbox: [], attention: [], ready: [], promoted: [] };
  for (const i of intakes) { const c = columnForState(i.state); if (c) g[c].push(i); }
  return g;
}
export function gateOpen(detail: Pick<ReviewIntakeDetail, 'latestTriage'>): boolean {
  const t = detail.latestTriage as any;
  return !!t && t.schemaVersion === 'triage.v1' && t.classification === 'triaged';
}
export function claimRemainingMs(claim: { expiresAt: number } | null | undefined, now: number): number {
  return claim ? Math.max(0, claim.expiresAt - now) : 0;
}

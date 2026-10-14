import type { KnowledgeFindingPriority, KnowledgeOpenFinding, KnowledgeReviewSummary } from '../../../../shared/types';
import { PRIORITY_ORDER } from './format';

// Open findings grouped folder → note, most severe first; and audits collapsed
// by the note set they covered (the same note is often re-audited).

export interface OpenNoteGroup {
  notePath: string;
  name: string;
  findings: KnowledgeOpenFinding[];
}

export interface OpenFolderGroup {
  folder: string;
  open: number;
  maxPriority: KnowledgeFindingPriority;
  counts: Partial<Record<KnowledgeFindingPriority, number>>;
  notes: OpenNoteGroup[];
}

const rank = (p: KnowledgeFindingPriority) => PRIORITY_ORDER.indexOf(p);
const worst = (findings: KnowledgeOpenFinding[]) =>
  findings.reduce<KnowledgeFindingPriority>((w, f) => (rank(f.priority) < rank(w) ? f.priority : w), 'low');

export function groupOpenFindings(items: KnowledgeOpenFinding[]): OpenFolderGroup[] {
  const folders = new Map<string, Map<string, KnowledgeOpenFinding[]>>();
  for (const item of items) {
    const notes = folders.get(item.folder) ?? new Map<string, KnowledgeOpenFinding[]>();
    notes.set(item.notePath, [...(notes.get(item.notePath) ?? []), item]);
    folders.set(item.folder, notes);
  }
  return [...folders].map(([folder, notes]) => {
    const all = [...notes.values()].flat();
    const counts: OpenFolderGroup['counts'] = {};
    for (const f of all) counts[f.priority] = (counts[f.priority] ?? 0) + 1;
    return {
      folder,
      open: all.length,
      maxPriority: worst(all),
      counts,
      notes: [...notes].map(([notePath, findings]) => ({
        notePath,
        name: notePath.split('/').pop() ?? notePath,
        findings: [...findings].sort((a, b) => rank(a.priority) - rank(b.priority) || b.lastReportedAt.localeCompare(a.lastReportedAt)),
      })).sort((a, b) => rank(worst(a.findings)) - rank(worst(b.findings)) || b.findings.length - a.findings.length || a.name.localeCompare(b.name)),
    };
  }).sort((a, b) => rank(a.maxPriority) - rank(b.maxPriority) || b.open - a.open || a.folder.localeCompare(b.folder));
}

export interface AuditGroup {
  key: string;
  latest: KnowledgeReviewSummary;
  earlier: KnowledgeReviewSummary[];
}

/** Reviews arrive newest first; audits of the same note set collapse under the newest one. */
export function groupAudits(reviews: KnowledgeReviewSummary[]): AuditGroup[] {
  const groups = new Map<string, AuditGroup>();
  for (const review of reviews) {
    const key = [...review.scope.paths].sort().join('\n') || review.reviewId;
    const group = groups.get(key);
    if (group) group.earlier.push(review);
    else groups.set(key, { key, latest: review, earlier: [] });
  }
  return [...groups.values()];
}

const DAY_MS = 86_400_000;

/** Whole days since the latest audit that reported the finding. */
export function daysSinceAudit(lastReportedAt: string, now: Date = new Date()): number {
  const t = Date.parse(lastReportedAt);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / DAY_MS)) : 0;
}

export const STALE_RECHECK_DAYS = 30;

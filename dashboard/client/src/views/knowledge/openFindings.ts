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

/**
 * A brief for one Librarian re-check run: the notes most worth re-checking
 * (worst priority, then longest since an audit looked at them), capped at the
 * workflow's default of 5 notes and at `maxFindings` so a hub note (Review Queue)
 * cannot swallow the run; a note over the cap contributes its worst findings first.
 */
export function buildRecheckBrief(
  items: KnowledgeOpenFinding[], totalOpen: number, now: Date = new Date(), maxNotes = 5, maxFindings = 15,
): string {
  const byNote = new Map<string, KnowledgeOpenFinding[]>();
  for (const item of items) byNote.set(item.notePath, [...(byNote.get(item.notePath) ?? []), item]);
  const oldest = (fs: KnowledgeOpenFinding[]) => fs.reduce((min, f) => (f.lastReportedAt < min ? f.lastReportedAt : min), fs[0].lastReportedAt);
  const notes = [...byNote].sort(([an, a], [bn, b]) => rank(worst(a)) - rank(worst(b)) || oldest(a).localeCompare(oldest(b)) || an.localeCompare(bn));
  const byUrgency = (a: KnowledgeOpenFinding, b: KnowledgeOpenFinding) =>
    rank(a.priority) - rank(b.priority) || a.lastReportedAt.localeCompare(b.lastReportedAt);
  const picked: [string, KnowledgeOpenFinding[], number][] = [];
  let budget = maxFindings;
  for (const [notePath, fs] of notes) {
    if (picked.length >= maxNotes || budget <= 0) break;
    const sorted = [...fs].sort(byUrgency);
    const take = sorted.slice(0, budget);
    picked.push([notePath, take, sorted.length - take.length]);
    budget -= take.length;
  }
  const findingCount = picked.reduce((n, [, fs]) => n + fs.length, 0);
  const date = now.toISOString().slice(0, 10);

  const lines = [
    `Knowledge re-check sweep — ${date}`,
    '',
    'Re-check these open Librarian findings (ai-dev-office/workflows/knowledge-librarian.md).',
    'For each fingerprint, record resolved (answer, closure evidence, closed_at), suppressed, or recurring',
    'with current evidence. Product or architecture choices stay open for a human.',
    `Scope: ${picked.length} note${picked.length === 1 ? '' : 's'} · ${findingCount} findings (of ${totalOpen} open; ${notes.length - picked.length} more notes in this selection wait for the next run).`,
  ];
  picked.forEach(([notePath, fs, left], i) => {
    lines.push('', `${i + 1}. ${notePath}`);
    for (const f of fs) {
      lines.push(`   - [${f.priority}] ${f.fingerprint} — last audited ${f.lastReportedAt.slice(0, 10)} (${daysSinceAudit(f.lastReportedAt, now)}d) in ${f.reviewId}`);
      lines.push(`     ${f.question}`);
    }
    if (left > 0) lines.push(`   (+${left} more open on this note for a later run)`);
  });
  return lines.join('\n');
}

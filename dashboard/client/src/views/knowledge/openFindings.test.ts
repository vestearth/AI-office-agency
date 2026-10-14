import { describe, expect, it } from 'vitest';
import type { KnowledgeOpenFinding, KnowledgeReviewSummary } from '../../../../shared/types';
import { buildRecheckBrief, daysSinceAudit, groupAudits, groupOpenFindings } from './openFindings';

const f = (fingerprint: string, folder: string, notePath: string, priority: KnowledgeOpenFinding['priority']): KnowledgeOpenFinding => ({
  fingerprint, folder, notePath, priority, question: '?', status: 'new', evidenceState: 'partial', recommendedAction: 'update_note',
  timesReported: 1, firstReportedAt: '2026-10-01T00:00:00Z', lastReportedAt: '2026-10-01T00:00:00Z', reviewId: 'KLR-1',
});

describe('groupOpenFindings', () => {
  it('orders folders by their worst finding, then by open count', () => {
    const groups = groupOpenFindings([
      f('a', '20 Flows', 'Knowledge Base/20 Flows/A.md', 'medium'),
      f('b', '20 Flows', 'Knowledge Base/20 Flows/A.md', 'medium'),
      f('c', '10 Projects/VerifySlip', 'Knowledge Base/10 Projects/VerifySlip/B.md', 'critical'),
      f('d', '40 Lessons', 'Knowledge Base/40 Lessons/C.md', 'medium'),
    ]);
    expect(groups.map((g) => [g.folder, g.open, g.maxPriority])).toEqual([
      ['10 Projects/VerifySlip', 1, 'critical'],
      ['20 Flows', 2, 'medium'],
      ['40 Lessons', 1, 'medium'],
    ]);
    expect(groups[1].counts).toEqual({ medium: 2 });
  });

  it('groups findings by note and names the note by its file', () => {
    const [group] = groupOpenFindings([
      f('a', '20 Flows', 'Knowledge Base/20 Flows/A.md', 'low'),
      f('b', '20 Flows', 'Knowledge Base/20 Flows/B.md', 'high'),
      f('c', '20 Flows', 'Knowledge Base/20 Flows/A.md', 'high'),
    ]);
    expect(group.notes.map((n) => [n.name, n.findings.map((x) => x.fingerprint)])).toEqual([
      ['A.md', ['c', 'a']],
      ['B.md', ['b']],
    ]);
  });
});

describe('groupAudits', () => {
  const review = (reviewId: string, paths: string[]) => ({ reviewId, scope: { paths } }) as unknown as KnowledgeReviewSummary;

  it('collapses audits of the same note set under the newest, ignoring path order', () => {
    const groups = groupAudits([
      review('KLR-3', ['b.md', 'a.md']),
      review('KLR-2', ['c.md']),
      review('KLR-1', ['a.md', 'b.md']),
    ]);
    expect(groups.map((g) => [g.latest.reviewId, g.earlier.map((r) => r.reviewId)])).toEqual([
      ['KLR-3', ['KLR-1']],
      ['KLR-2', []],
    ]);
  });

  it('never merges audits that recorded no paths', () => {
    expect(groupAudits([review('KLR-2', []), review('KLR-1', [])])).toHaveLength(2);
  });
});

describe('re-check brief', () => {
  const now = new Date('2026-10-14T12:00:00Z');
  const at = (fp: string, note: string, priority: KnowledgeOpenFinding['priority'], lastReportedAt: string) =>
    ({ ...f(fp, 'x', note, priority), lastReportedAt, reviewId: `KLR-${fp}` });

  it('counts whole days since the last audit', () => {
    expect(daysSinceAudit('2026-09-04T12:00:00Z', now)).toBe(40);
    expect(daysSinceAudit('2026-10-14T11:00:00Z', now)).toBe(0);
  });

  it('picks the worst, then stalest notes up to the cap and keeps every fingerprint on them', () => {
    const brief = buildRecheckBrief([
      at('fresh-high', 'N/fresh.md', 'high', '2026-10-13T00:00:00Z'),
      at('old-high', 'N/old.md', 'high', '2026-08-01T00:00:00Z'),
      at('old-high-2', 'N/old.md', 'low', '2026-09-01T00:00:00Z'),
      at('crit', 'N/crit.md', 'critical', '2026-10-10T00:00:00Z'),
      at('low', 'N/low.md', 'low', '2026-07-01T00:00:00Z'),
    ], 275, now, 2);
    expect(brief).toContain('Scope: 2 notes · 3 findings (of 275 open; 2 more notes in this selection wait for the next run).');
    const order = ['1. N/crit.md', '2. N/old.md'].map((line) => brief.indexOf(line));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order[0]).toBeLessThan(order[1]);
    expect(brief).toContain('[high] old-high — last audited 2026-08-01 (74d) in KLR-old-high');
    expect(brief).toContain('[low] old-high-2');
    expect(brief).not.toContain('N/fresh.md');
    expect(brief).not.toContain('N/low.md');
  });

  it('caps findings so one hub note cannot take the whole run', () => {
    const hub = Array.from({ length: 20 }, (_, i) => at(`hub-${i}`, 'KB/Review Queue.md', i < 2 ? 'critical' : 'medium', '2026-08-01T00:00:00Z'));
    const brief = buildRecheckBrief([...hub, at('other', 'N/other.md', 'high', '2026-08-01T00:00:00Z')], 275, now, 5, 15);
    expect(brief).toContain('Scope: 1 note · 15 findings');
    expect(brief).toContain('[critical] hub-0');
    expect(brief).toContain('(+5 more open on this note for a later run)');
    expect(brief).not.toContain('N/other.md');
  });
});

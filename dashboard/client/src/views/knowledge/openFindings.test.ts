import { describe, expect, it } from 'vitest';
import type { KnowledgeOpenFinding, KnowledgeReviewSummary } from '../../../../shared/types';
import { groupAudits, groupOpenFindings } from './openFindings';

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

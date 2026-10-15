import { describe, expect, it } from 'vitest';
import type { KnowledgeOpenFinding } from '../../../shared/types';
import { decisionCounts } from './KnowledgeDecisionsLine';

const f = (fingerprint: string, over: Partial<KnowledgeOpenFinding> = {}): KnowledgeOpenFinding => ({
  fingerprint, notePath: 'n.md', folder: 'x', question: '?', priority: 'low', status: 'new', evidenceState: 'confirmed',
  recommendedAction: 'no_change', needsHumanDecision: true, timesReported: 1, firstReportedAt: '', lastReportedAt: '2026-10-10T00:00:00Z',
  reviewId: 'KLR-1', closureCriteria: '', ...over,
});
const answer = (a: 'approve' | 'defer', pending: boolean) => ({
  humanDecision: { id: 'hd-001', fingerprint: 'x', answer: a, actor: 'earth', decidedAt: '2026-10-15T00:00:00Z', question: '', notePath: '' },
  decisionPending: pending,
});

describe('decisionCounts', () => {
  it('waiting = unanswered or kept open by a later re-check; pending = answered, waiting for the run; deferred and machine findings count in neither', () => {
    const counts = decisionCounts({
      generatedAt: '', totals: { fingerprints: 5, open: 5, resolved: 0, suppressed: 0 },
      items: [f('a'), f('b', answer('approve', true)), f('c', answer('approve', false)), f('d', answer('defer', false)), f('e', { needsHumanDecision: false })],
    });
    expect(counts).toEqual({ waiting: 2, pending: 1 });
  });
});

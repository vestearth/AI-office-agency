import { describe, expect, it } from 'vitest';
import type { KnowledgeOpenFinding } from '../../../../shared/types';
import { decisionState, groupByKind, BULK_ANSWER, refLabel, taskRefs } from './decisionQueue';

const f = (fingerprint: string, over: Partial<KnowledgeOpenFinding> = {}): KnowledgeOpenFinding => ({
  fingerprint, notePath: `${fingerprint}.md`, folder: 'x', question: '?', priority: 'medium', status: 'new', evidenceState: 'confirmed',
  recommendedAction: 'no_change', needsHumanDecision: true, timesReported: 1, firstReportedAt: '', lastReportedAt: '2026-10-10T00:00:00Z',
  reviewId: 'KLR-1', closureCriteria: '', decisionKind: 'status_check', ...over,
});
const answered = (answer: 'approve' | 'defer', pending: boolean) => ({
  humanDecision: { id: 'hd-001', fingerprint: 'x', answer, actor: 'earth', decidedAt: '2026-10-15T00:00:00Z', question: '', notePath: '' },
  decisionPending: pending,
});

describe('decisionQueue', () => {
  it('decisionState: unanswered, pending, deferred, kept open by a later re-check', () => {
    expect(decisionState(f('a'))).toBe('unanswered');
    expect(decisionState(f('a', answered('approve', true)))).toBe('pending');
    expect(decisionState(f('a', answered('defer', false)))).toBe('deferred');
    expect(decisionState(f('a', answered('approve', false)))).toBe('kept_open');
  });

  it('groups by kind in a fixed order, unanswered first, then priority; skips machine findings', () => {
    const groups = groupByKind([
      f('p', { decisionKind: 'product' }),
      f('s-pending', answered('approve', true)),
      f('s-low', { priority: 'low' }),
      f('s-high', { priority: 'high' }),
      f('d', { decisionKind: 'duplicate_proposal' }),
      f('m', { needsHumanDecision: false }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['duplicate_proposal', 'status_check', 'product']);
    expect(groups[1]!.items.map((i) => i.fingerprint)).toEqual(['s-high', 's-low', 's-pending']);
  });
});

describe('task references on decision cards', () => {
  it('finds each task id once, with and without a project prefix', () => {
    expect(taskRefs('Does TASK-EAR-363 still say it waits? See TASK-EAR-363 and TASK-12.')).toEqual(['TASK-EAR-363', 'TASK-12']);
    expect(taskRefs('No task here')).toEqual([]);
  });
  it('labels the referenced run by its current state', () => {
    expect(refLabel({ status: 'cancelled', currentStep: 'aborted', completedAt: '2026-10-12' })).toBe('aborted 10-12');
    expect(refLabel({ status: 'completed', currentStep: 'done', completedAt: '2026-09-26T10:00:00Z' })).toMatch(/ 09-26$/);
    expect(refLabel({ status: 'waiting_review', currentStep: 'in_review' })).not.toMatch(/\d/);
    expect(refLabel(undefined)).toBe('no run found');
  });
  it('offers one bulk answer only where every question shares it', () => {
    expect(BULK_ANSWER).toEqual({ duplicate_proposal: 'existing_proposal_enough', status_check: 'check_it' });
  });
});

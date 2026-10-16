import { describe, expect, it } from 'vitest';
import type { ReviewSummary } from '../../../shared/types';
import { closedNote } from './monitorDetail';
import { formatMoved, formatStamp } from './monitorList';

const review = (over: Partial<ReviewSummary>) => ({ phase: null, lastTransition: null, statusUpdatedAt: null, ...over }) as Pick<ReviewSummary, 'phase' | 'lastTransition' | 'statusUpdatedAt'>;

describe('closedNote', () => {
  it('reads the transition that closed the run', () => {
    expect(closedNote(review({ phase: 'aborted', lastTransition: { agent: 'pm', phase: 'debugging -> aborted', reason: 'redesign', at: '2026-10-16T10:00:43Z' } })))
      .toEqual({ phase: 'aborted', at: '2026-10-16T10:00:43Z', reason: 'redesign' });
  });
  it('falls back to the status date when the last transition is something else, and ignores open runs', () => {
    expect(closedNote(review({ phase: 'done', statusUpdatedAt: '2026-10-12', lastTransition: { agent: 'reviewer', phase: 'gate x', reason: 'r', at: null } })))
      .toEqual({ phase: 'done', at: '2026-10-12', reason: null });
    expect(closedNote(review({ phase: 'in_review' }))).toBeNull();
  });
});

describe('formatStamp', () => {
  // Timeline rows showed raw UTC ISO ("2026-10-16T18:54:45Z") next to local times in the list.
  it('formats a timestamp as local month-day and time, a bare date as a date', () => {
    expect(formatStamp('2026-10-16T18:54:45Z')).toMatch(/Oct 16, 18:54/);
    expect(formatStamp('2026-10-16')).toMatch(/Oct 16, 2026/);
    expect(formatStamp(undefined)).toBe('—');
  });
});

describe('formatMoved', () => {
  // npm test runs with TZ=UTC.
  it('shows the hand-off date and time the list sorts by', () => {
    expect(formatMoved({ lastHandoffAt: '2026-10-16T07:09:00.000Z', updatedAt: '2026-10-16' })).toMatch(/Oct 16, 07:09/);
  });
  it('falls back to updated_at', () => {
    expect(formatMoved({ updatedAt: '2026-10-12' })).toMatch(/Oct 12, 2026/);
  });
});

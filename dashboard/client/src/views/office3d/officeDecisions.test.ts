import { describe, expect, it } from 'vitest';
import { decidedNoLaterThan } from './officeDecisions';

describe('decidedNoLaterThan', () => {
  it('compares to the second, because the history row keeps no milliseconds', () => {
    expect(decidedNoLaterThan('2026-10-24T00:53:00.500Z', '2026-10-24T00:53:00Z')).toBe(true);
    expect(decidedNoLaterThan('2026-10-24T00:53:00.999Z', '2026-10-24T00:53:00Z')).toBe(true);
    expect(decidedNoLaterThan('2026-10-24T00:52:59.999Z', '2026-10-24T00:53:00Z')).toBe(true);
    expect(decidedNoLaterThan('2026-10-24T00:53:01.000Z', '2026-10-24T00:53:00Z')).toBe(false);
  });

  it('never matches a missing or unparseable time', () => {
    expect(decidedNoLaterThan(null, '2026-10-24T00:53:00Z')).toBe(false);
    expect(decidedNoLaterThan('2026-10-24T00:53:00Z', null)).toBe(false);
    expect(decidedNoLaterThan('2026-10-24T00:53:00Z', undefined)).toBe(false);
    expect(decidedNoLaterThan('not a time', '2026-10-24T00:53:00Z')).toBe(false);
  });
});

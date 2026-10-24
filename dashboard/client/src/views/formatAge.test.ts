import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatAge, statusTimeMs } from './formatAge';

describe('formatAge in Bangkok', () => {
  // npm test pins TZ=UTC, where local and UTC midnight coincide and a UTC reading would pass too.
  let savedTz: string | undefined;
  beforeEach(() => {
    savedTz = process.env.TZ;
    process.env.TZ = 'Asia/Bangkok';
    expect(new Date(2026, 9, 24).getTimezoneOffset()).toBe(-420);
  });
  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  it('ages a date-only value from local midnight, so Attention\'s Age agrees with the stale tag beside it', () => {
    // 03:00 local on the 24th, when the server's idle reads 2026-10-16 as 8 days: from UTC midnight it was 7d.
    expect(formatAge('2026-10-16', new Date(2026, 9, 24, 3).getTime())).toBe('8d');
    // 10:00 local: today's date is 10 hours old, not the 3 hours since UTC midnight.
    expect(formatAge('2026-10-24', new Date(2026, 9, 24, 10).getTime())).toBe('10h');
  });

  it('keeps a full timestamp as the instant it names', () => {
    expect(formatAge('2026-10-23T19:15:00Z', Date.parse('2026-10-23T20:00:00Z'))).toBe('45m');
    expect(formatAge('2026-10-16T00:00:00Z', Date.parse('2026-10-23T20:00:00Z'))).toBe('7d');
  });

  it('says Unknown without a usable value', () => {
    expect(formatAge(null)).toBe('Unknown');
    expect(formatAge('not a date')).toBe('Unknown');
  });
});

describe('a date-only value that is not a calendar date', () => {
  it('has no time and no age, as on the server', () => {
    for (const value of ['2026-13-01', '2026-10-32', '2026-10-00', '2026-02-30', '2026-04-31']) {
      expect(statusTimeMs(value), value).toBeNaN();
      expect(formatAge(value), value).toBe('Unknown');
    }
    expect(statusTimeMs('2028-02-29')).toBe(new Date(2028, 1, 29).getTime());
  });
});

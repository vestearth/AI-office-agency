import { afterEach, beforeEach, expect } from 'vitest';

/**
 * Runs the enclosing describe block in Asia/Bangkok (UTC+7). npm test pins TZ=UTC, where local and
 * UTC midnight coincide, so a date-only value read as UTC midnight would pass every local-midnight case.
 */
export function inBangkok(): void {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.TZ;
    process.env.TZ = 'Asia/Bangkok';
    // Node applies a TZ change at once; fail here rather than pass vacuously if this runtime does not.
    expect(new Date(2026, 9, 24).getTimezoneOffset()).toBe(-420);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });
}

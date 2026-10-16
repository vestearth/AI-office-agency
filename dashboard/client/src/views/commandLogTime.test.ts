import { describe, expect, it } from 'vitest';
import { formatLiveLogStamp } from './commandLogTime';

// npm test runs with TZ=UTC, so local time equals UTC here.
describe('formatLiveLogStamp moment', () => {
  it('shows month-day and time when the value has a time of day', () => {
    expect(formatLiveLogStamp('2026-10-16T07:05:45Z', 'moment')).toBe('10-16 07:05');
  });
  it('falls back to the date for a date-only value, and dashes when empty', () => {
    expect(formatLiveLogStamp('2026-10-16', 'moment')).toBe('2026-10-16');
    expect(formatLiveLogStamp(undefined, 'moment')).toBe('--:--:--');
  });
});

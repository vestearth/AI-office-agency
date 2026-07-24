import assert from 'node:assert/strict';
import { test } from 'vitest';
import { formatLiveLogStamp } from '../src/views/commandLogTime.ts';

test('formatLiveLogStamp renders date-only task updates as a date', () => {
  assert.equal(formatLiveLogStamp('2026-06-08', 'date'), '2026-06-08');
});

test('formatLiveLogStamp renders event timestamps as local HH:MM:SS', () => {
  assert.match(formatLiveLogStamp('2026-06-08T00:00:00.000Z', 'time'), /^\d{2}:\d{2}:\d{2}$/);
});

test('formatLiveLogStamp renders invalid values as date fallback for task updates', () => {
  assert.equal(formatLiveLogStamp(undefined, 'date'), '---- -- --');
  assert.equal(formatLiveLogStamp('not-a-date', 'date'), '---- -- --');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { officeMs } from './officeTime';

test('officeMs reads a date-only value as midnight in the office time zone and keeps a timestamp as named', () => {
  assert.equal(officeMs('2026-10-16'), Date.parse('2026-10-15T17:00:00Z'));
  assert.equal(officeMs('2028-02-29'), Date.parse('2028-02-28T17:00:00Z'));
  assert.equal(officeMs('2026-10-16T00:00:00Z'), Date.parse('2026-10-16T00:00:00Z'));
});

test('officeMs gives NaN, never an error, for a date-only value that is not a calendar date', () => {
  // Date.parse refuses 2026-13-01 (and Intl then threw on the NaN) but rolls 2026-02-30 over to March 2.
  for (const value of ['2026-13-01', '2026-10-32', '2026-10-00', '2026-02-30', '2026-04-31']) {
    assert.ok(Number.isNaN(officeMs(value)), value);
  }
});

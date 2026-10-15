import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RunStatus } from '../../shared/types';
import { countRuns, doneRateWithin, isActiveStatus } from '../../shared/runCounts.ts';

const runs = (...statuses: RunStatus[]) => statuses.map((status) => ({ status }));

test('active is open work: running, review, blocked, queued, failed', () => {
  const counts = countRuns(runs('running', 'waiting_review', 'blocked', 'queued', 'failed', 'completed', 'cancelled', 'unknown'));
  assert.equal(counts.active, 5);
  assert.equal(counts.total, 8);
});

test('unreadable runs are counted on their own, never as active or done', () => {
  const counts = countRuns(runs('unknown', 'unknown', 'completed'));
  assert.equal(counts.unreadable, 2);
  assert.equal(counts.active, 0);
  assert.equal(counts.completed, 1);
  assert.equal(isActiveStatus('unknown'), false);
});

test('success rate covers finished work only, so open work does not drag it down', () => {
  assert.equal(countRuns(runs('completed', 'running', 'blocked')).successRate, 1);
  assert.equal(countRuns(runs('completed', 'failed', 'cancelled', 'completed')).successRate, 0.5);
  assert.equal(countRuns(runs('running')).successRate, 0);
});

test('doneRateWithin: done share of runs finished in the window; null when none finished', () => {
  const now = Date.parse('2026-10-16T00:00:00Z');
  const r = (status: RunStatus, completedAt?: string) => ({ status, completedAt });
  const rate = doneRateWithin([
    r('completed', '2026-10-10T00:00:00Z'), r('completed', '2026-10-01T00:00:00Z'), r('cancelled', '2026-10-12T00:00:00Z'),
    r('completed', '2026-08-01T00:00:00Z'), // outside 30 days
    r('running'), r('completed'), // open, or no completion date
  ], 30, now);
  assert.deepEqual(rate, { rate: 2 / 3, finished: 3, completed: 2 });
  assert.equal(doneRateWithin([r('completed', '2026-01-01T00:00:00Z')], 30, now).rate, null);
});

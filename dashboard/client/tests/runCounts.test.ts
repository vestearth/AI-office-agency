import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RunStatus } from '../../shared/types';
import { countRuns, isActiveStatus } from '../../shared/runCounts.ts';

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

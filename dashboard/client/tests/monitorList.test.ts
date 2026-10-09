import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RunSummary } from '../../shared/types';
import { filterRuns, formatUpdated, groupByMonth, inScope, prefixCounts, runPrefix } from '../src/views/monitorList.ts';

const run = (id: string, status: RunSummary['status'], updatedAt?: string, title = id): RunSummary =>
  ({ id, title, status, updatedAt, runPath: `runs/${id}` });

test('runPrefix names the namespace, with legacy TASK-NNN as TASK', () => {
  assert.equal(runPrefix('TASK-EAR-385'), 'EAR');
  assert.equal(runPrefix('TASK-VS-004'), 'VS');
  assert.equal(runPrefix('TASK-PKG-002'), 'PKG');
  assert.equal(runPrefix('TASK-123'), 'TASK');
});

test('scopes: active is open work, finished is done or aborted, all includes unreadable', () => {
  assert.equal(inScope('blocked', 'active'), true);
  assert.equal(inScope('completed', 'active'), false);
  assert.equal(inScope('cancelled', 'finished'), true);
  assert.equal(inScope('unknown', 'finished'), false);
  assert.equal(inScope('unknown', 'all'), true);
});

test('filterRuns combines scope, prefix and search over id and title', () => {
  const runs = [
    run('TASK-EAR-1', 'running', undefined, 'Favorites API'),
    run('TASK-EAR-2', 'completed'),
    run('TASK-VS-3', 'blocked'),
  ];
  assert.deepEqual(filterRuns(runs, { scope: 'active', prefix: null, search: '' }).map((r) => r.id), ['TASK-EAR-1', 'TASK-VS-3']);
  assert.deepEqual(filterRuns(runs, { scope: 'all', prefix: 'EAR', search: '' }).map((r) => r.id), ['TASK-EAR-1', 'TASK-EAR-2']);
  assert.deepEqual(filterRuns(runs, { scope: 'all', prefix: null, search: 'favor' }).map((r) => r.id), ['TASK-EAR-1']);
});

test('prefixCounts counts within the current scope, largest first', () => {
  const runs = [run('TASK-EAR-1', 'running'), run('TASK-EAR-2', 'queued'), run('TASK-VS-3', 'blocked'), run('TASK-VS-4', 'completed')];
  assert.deepEqual(prefixCounts(runs, 'active'), [{ prefix: 'EAR', count: 2 }, { prefix: 'VS', count: 1 }]);
});

test('groupByMonth groups by the month of the last update, newest first, undated last', () => {
  const groups = groupByMonth([
    run('A', 'completed', '2026-08-03'),
    run('B', 'completed', '2026-09-17'),
    run('C', 'completed'),
    run('D', 'completed', '2026-09-01T10:00:00.000Z'),
  ]);
  assert.deepEqual(groups.map((g) => [g.key, g.runs.map((r) => r.id)]), [
    ['2026-09', ['B', 'D']],
    ['2026-08', ['A']],
    ['undated', ['C']],
  ]);
});

test('formatUpdated shows a date-only value as a date, never a made-up time', () => {
  const shown = formatUpdated('2026-09-17');
  assert.ok(shown.includes('2026') && shown.includes('17'), shown);
  assert.ok(!/\d:\d\d/.test(shown), `no clock time expected: ${shown}`);
  assert.ok(/\d:\d\d/.test(formatUpdated('2026-09-17T08:30:00.000Z')), 'a real timestamp keeps its time');
  assert.equal(formatUpdated(undefined), '—');
});

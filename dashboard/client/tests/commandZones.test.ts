import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  ZONE_BY_ID, ZONE_COLORS as C, summarizeZones, zoneNeedsEye, zonePreview, zoneTone, type ZoneTask,
} from '../src/views/commandZones.ts';
import { formatAge } from '../src/views/formatAge.ts';

const task = (taskId: string, over: Partial<ZoneTask> = {}): ZoneTask => ({
  taskId, phase: 'assigned', status: 'running', needsReview: false, ...over,
});
const zone = (id: string) => ZONE_BY_ID.get(id)!;
const idle = { count: 3, attention: false, active: false };

test('blocked and validation-failed zones warn whenever they hold tasks', () => {
  assert.equal(zoneTone(zone('blocked'), idle), C.amber);
  assert.equal(zoneTone(zone('rejected'), idle), C.red);
  assert.equal(zoneNeedsEye(zone('blocked'), idle), true);
});

test('finished zones stay neutral no matter how many tasks they hold', () => {
  assert.equal(zoneTone(zone('done'), { count: 519, attention: false, active: false }), C.gray);
  assert.equal(zoneTone(zone('aborted'), { count: 11, attention: true, active: false }), C.gray);
  assert.equal(zoneNeedsEye(zone('aborted'), { count: 11, attention: true }), false);
});

test('work zones: amber needs a human, cyan agent working, green queued, gray empty', () => {
  assert.equal(zoneTone(zone('review'), { count: 5, attention: true, active: true }), C.amber);
  assert.equal(zoneTone(zone('dev'), { count: 4, attention: false, active: true }), C.cyan);
  assert.equal(zoneTone(zone('inbox'), idle), C.green);
  assert.equal(zoneTone(zone('debug'), { count: 0, attention: false, active: false }), C.gray);
});

test('summarizeZones tracks the stalest update per zone', () => {
  const stats = summarizeZones([
    task('A', { updatedAt: '2026-10-12T00:00:00Z' }),
    task('B', { updatedAt: '2026-10-10T00:00:00Z', currentAgent: 'dev' }),
    task('C', { phase: 'in_review', needsReview: true }),
  ]);
  assert.equal(stats.get('dev')?.count, 2);
  assert.equal(stats.get('dev')?.oldest, '2026-10-10T00:00:00Z');
  // Dev Bay holds the assigned phases only: an assigned run nobody started is queued, not
  // "agent on it" (operator decision 2026-10-15, Command review item 3; the label reads "Assigned").
  assert.equal(stats.get('dev')?.active, false);
  assert.equal(stats.get('review')?.attention, true);
});

test('preview leads with tasks needing a human, then the stalest; terminal zones show newest', () => {
  const open = [
    task('new', { updatedAt: '2026-10-13T00:00:00Z' }),
    task('old', { updatedAt: '2026-10-01T00:00:00Z' }),
    task('ask', { updatedAt: '2026-10-14T00:00:00Z', needsReview: true }),
  ];
  assert.deepEqual(zonePreview(zone('dev'), open).map((t) => t.taskId), ['ask', 'old', 'new']);
  assert.deepEqual(zonePreview(zone('done'), open, 2).map((t) => t.taskId), ['ask', 'new']);
});

test('formatAge buckets minutes, hours, then days', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  assert.equal(formatAge('2026-10-14T11:15:00Z', now), '45m');
  assert.equal(formatAge('2026-10-13T12:00:00Z', now), '24h');
  assert.equal(formatAge('2026-10-10T12:00:00Z', now), '4d');
  assert.equal(formatAge(undefined, now), 'Unknown');
});

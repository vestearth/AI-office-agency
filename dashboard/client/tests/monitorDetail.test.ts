import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentTimelineEvent } from '../../shared/types';
import { idleLabel, timelineView } from '../src/views/monitorDetail.ts';

const events = (...ids: string[]): AgentTimelineEvent[] =>
  ids.map((id) => ({ id, agent: 'pm', agentKind: 'role', action: id, timestamp: '2026-09-25' }));

test('timeline shows the newest event first, even when timestamps tie on the same day', () => {
  const { shown, hidden } = timelineView(events('created', 'assigned', 'review'), false);
  assert.deepEqual(shown.map((e) => e.id), ['review', 'assigned', 'created']);
  assert.equal(hidden, 0);
});

test('collapsed timeline keeps the latest N and counts the rest; expanded shows all', () => {
  const all = events('1', '2', '3', '4', '5', '6', '7');
  const collapsed = timelineView(all, false, 5);
  assert.deepEqual(collapsed.shown.map((e) => e.id), ['7', '6', '5', '4', '3']);
  assert.equal(collapsed.hidden, 2);
  assert.equal(timelineView(all, true, 5).shown.length, 7);
});

test('timelineView does not reorder the caller array', () => {
  const all = events('a', 'b');
  timelineView(all, false);
  assert.deepEqual(all.map((e) => e.id), ['a', 'b']);
});

test('idle label comes only from the server stale rule', () => {
  assert.equal(idleLabel({ idle: { days: 19, thresholdDays: 7 } }), 'idle 19d');
  assert.equal(idleLabel({ idle: null }), null);
  assert.equal(idleLabel(undefined), null);
});

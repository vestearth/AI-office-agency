import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentTimelineEvent, ReviewSummary, RunSummary } from '../../shared/types';
import { idleLabel, monitorHome, timelineView } from '../src/views/monitorDetail.ts';

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

const run = (id: string, updatedAt: string, status: RunSummary['status'] = 'running'): RunSummary => ({ id, title: id, status, updatedAt, runPath: `runs/${id}` });
const flagged = (taskId: string, over: Partial<ReviewSummary> = {}): ReviewSummary => ({
  taskId, title: taskId, phase: 'assigned', verdict: null, inReviewQueue: false, verdictNeedsAttention: false, needsReview: false,
  requiresAction: true, actionKind: 'stale_work', actionReason: 'why', recommendedAction: null, decisionPending: false,
  statusUpdatedAt: null, lastReviewedAt: null, confidence: null, issueCounts: { error: 0, warning: 0, suggestion: 0 },
  riskLevel: 'none', latestDecision: null, idle: null, lastTransition: null, ...over,
});

test('monitor home: recent runs newest first across every status, waiting runs longest-idle first, capped', () => {
  const runs = [run('A', '2026-10-10'), run('B', '2026-10-14', 'completed'), run('C', '2026-10-12'), run('D', '2026-10-13', 'blocked')];
  const reviews = new Map([
    ['A', flagged('A', { idle: { days: 19, thresholdDays: 14 } })],
    ['C', flagged('C', { statusUpdatedAt: '2026-10-12' })],
    ['D', flagged('D', { statusUpdatedAt: '2026-10-13' })],
  ]);
  const home = monitorHome(runs, reviews, 2);
  assert.deepEqual(home.recent.map((r) => r.id), ['B', 'D']);
  assert.deepEqual(home.waiting.map((w) => w.run.id), ['A', 'C']);
  assert.equal(home.waitingTotal, 3);
});

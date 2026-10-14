import test from 'node:test';
import assert from 'node:assert/strict';
import type { ActionKind, ReviewSummary, RunStatus, RunSummary } from '@shared/types';
import { buildFlowHealth, buildFlowInsights, type HistoryEntry } from './flowInsights';

const NOW = new Date('2026-10-14T12:00:00Z');

const run = (id: string, status: RunStatus, over: Partial<RunSummary> = {}): RunSummary => ({
  id, title: `${id} title`, status, runPath: `runs/${id}`, updatedAt: '2026-10-14T00:00:00Z', ...over,
});

const review = (taskId: string, over: Partial<ReviewSummary> = {}): ReviewSummary => ({
  taskId, title: taskId, phase: null, verdict: null, inReviewQueue: false, verdictNeedsAttention: false,
  needsReview: false, requiresAction: false, actionKind: null, actionReason: null, recommendedAction: null,
  decisionPending: false, statusUpdatedAt: null, lastReviewedAt: null, confidence: null,
  issueCounts: { error: 0, warning: 0, suggestion: 0 }, riskLevel: 'none', latestDecision: null, idle: null, lastTransition: null, ...over,
});

const flagged = (kind: ActionKind, extra: Partial<ReviewSummary> = {}) =>
  ({ requiresAction: true, actionKind: kind, ...extra });

const build = (runs: RunSummary[], reviews: ReviewSummary[] = [], histories = new Map<string, HistoryEntry[]>(), windowDays = 7) =>
  buildFlowInsights({ runs, reviews, histories, now: NOW, windowDays });

test('stuck work counts open runs regardless of how long ago they started', () => {
  // The old window filtered by startedAt, so a block from September vanished from health.
  const flow = build([
    run('TASK-1', 'blocked', { startedAt: '2026-09-02' }),
    run('TASK-2', 'running', { startedAt: '2026-09-25' }),
    run('TASK-3', 'completed', { startedAt: '2026-10-13', completedAt: '2026-10-14T01:00:00Z' }),
  ], [
    review('TASK-1', { phase: 'blocked', ...flagged('workflow_exception') }),
    review('TASK-2', { phase: 'assigned', ...flagged('stale_work'), idle: { days: 19, thresholdDays: 14 } }),
  ]);
  assert.equal(flow.stuck.open, 2);
  assert.equal(flow.stuck.blocked, 1);
  assert.equal(flow.stuck.idle, 1);
  assert.equal(flow.stuck.needsYou, 2);
});

test('byKind counts open runs per Action Center kind, most frequent first', () => {
  const flow = build([
    run('TASK-B', 'blocked'),
    run('TASK-I', 'running'),
    run('TASK-R', 'waiting_review'),
    run('TASK-F', 'failed'),
    run('TASK-OK', 'running'),
  ], [
    review('TASK-B', { phase: 'blocked', ...flagged('workflow_exception') }),
    review('TASK-I', { phase: 'assigned', idle: { days: 20, thresholdDays: 14 }, ...flagged('stale_work') }),
    review('TASK-R', { phase: 'in_review', ...flagged('awaiting_review') }),
    review('TASK-F', { phase: 'validation_failed' }),
    review('TASK-OK', { phase: 'assigned' }),
  ]);
  assert.deepEqual(flow.stuck.byKind, [
    { kind: 'awaiting_review', count: 1 }, { kind: 'stale_work', count: 1 }, { kind: 'workflow_exception', count: 1 },
  ]);
});

test('waits group open runs by phase with the longest wait since the last status change', () => {
  const flow = build([
    run('TASK-1', 'waiting_review'), run('TASK-2', 'waiting_review'), run('TASK-3', 'blocked'),
  ], [
    review('TASK-1', { phase: 'in_review', statusUpdatedAt: '2026-10-12T12:00:00Z' }),
    review('TASK-2', { phase: 'in_review', statusUpdatedAt: '2026-10-14T06:00:00Z' }),
    review('TASK-3', { phase: 'blocked', statusUpdatedAt: '2026-10-04T12:00:00Z' }),
  ]);
  assert.deepEqual(flow.waits, [
    { phase: 'in_review', count: 2, oldestDays: 2 },
    { phase: 'blocked', count: 1, oldestDays: 10 },
  ]);
  assert.equal(flow.stuck.oldestDays, 10);
});

test('health is a flat per-task penalty over current open work', () => {
  // Live data on 2026-10-14: 1 idle, 6 blocked → 100 − 5 − 12 = 83 (warning).
  const live = buildFlowHealth({ failed: 0, idle: 1, unreadable: 0, blocked: 6 });
  assert.equal(live.score, 83);
  assert.equal(live.status, 'warning');
  assert.deepEqual(live.factors.map((f) => [f.label, f.impact]), [['failed', 0], ['idle', -5], ['unreadable', 0], ['blocked', -12]]);

  assert.equal(buildFlowHealth({ failed: 0, idle: 0, unreadable: 0, blocked: 5 }).status, 'ok');
  assert.equal(buildFlowHealth({ failed: 3, idle: 0, unreadable: 0, blocked: 0 }).status, 'warning'); // 70: warning boundary
  assert.equal(buildFlowHealth({ failed: 4, idle: 0, unreadable: 0, blocked: 0 }).status, 'error');
  assert.equal(buildFlowHealth({ failed: 20, idle: 0, unreadable: 0, blocked: 0 }).score, 0);
});

test('health counts unreadable runs from every run, not only open ones', () => {
  const flow = build([run('TASK-1', 'unknown'), run('TASK-2', 'completed')]);
  assert.equal(flow.health.factors.find((f) => f.label === 'unreadable')?.count, 1);
  assert.equal(flow.health.score, 95);
});

test('throughput counts closes by completedAt and opens by startedAt inside the window', () => {
  const flow = build([
    run('TASK-1', 'completed', { startedAt: '2026-10-10T12:00:00Z', completedAt: '2026-10-12T12:00:00Z' }),
    run('TASK-2', 'completed', { startedAt: '2026-09-01T00:00:00Z', completedAt: '2026-10-13T00:00:00Z' }),
    run('TASK-3', 'completed', { startedAt: '2026-09-01T00:00:00Z', completedAt: '2026-09-02T00:00:00Z' }),
    run('TASK-4', 'cancelled', { startedAt: '2026-10-11T00:00:00Z', completedAt: '2026-10-11T06:00:00Z' }),
    run('TASK-5', 'running', { startedAt: '2026-10-14T01:00:00Z' }),
  ], [], new Map(), 7);
  assert.equal(flow.throughput.closed, 2);
  assert.equal(flow.throughput.opened, 3);
  assert.deepEqual(flow.throughput.cycleDays, { median: 2, p90: 42, sample: 2 });
  assert.equal(flow.throughput.days.length, 7);
  assert.deepEqual(flow.throughput.days.at(-1), { date: '2026-10-14', opened: 1, closed: 0 });
  assert.deepEqual(flow.throughput.days.find((d) => d.date === '2026-10-12'), { date: '2026-10-12', opened: 0, closed: 1 });
});

test('movers count in-window phase transitions by role and operator, skipping gate updates', () => {
  const histories = new Map<string, HistoryEntry[]>([
    ['TASK-1', [
      { phase: 'created -> assigned', agent: 'pm', at: '2026-10-01T00:00:00Z' },
      { phase: 'assigned -> in_review', agent: 'dev', at: '2026-10-13T00:00:00Z' },
      { phase: 'gate deploy_staging: pending -> pass', agent: 'reviewer', at: '2026-10-13T01:00:00Z' },
      { phase: 'in_review -> done', agent: 'reviewer', at: '2026-10-14T00:00:00Z' },
    ]],
    ['TASK-2', [
      { phase: 'blocked -> assigned', agent: 'claude', at: new Date('2026-10-12T00:00:00Z') },
      { phase: 'assigned -> in_review', agent: 'dev', at: '2026-10-12T05:00:00Z' },
    ]],
    ['TASK-3', [{ phase: 'created -> assigned', agent: 'pm', at: '2026-09-01T00:00:00Z' }]],
  ]);
  const flow = build([], [], histories);
  assert.deepEqual(flow.movers.roles.map((m) => [m.actor, m.transitions]), [['dev', 2], ['reviewer', 1]]);
  assert.deepEqual(flow.movers.conductors.map((m) => [m.actor, m.transitions]), [['claude', 1]]);
  assert.equal(flow.movers.runsWithTransitions, 2);
  assert.equal(flow.movers.runsWithConductor, 1);
});

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
  issueCounts: { error: 0, warning: 0, suggestion: 0 }, riskLevel: 'none', latestDecision: null, idle: null, lastTransition: null, waitsOn: [], isReleaseTrain: false, ...over,
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

test('needsYou matches Attention: a closed run that still needs a human counts, and is reported separately', () => {
  // 2026-10-15: Flow said 11, Attention 12 — TASK-EAR-386 (done) had artifact drift.
  const flow = build([
    run('TASK-1', 'blocked'),
    run('TASK-2', 'completed', { completedAt: '2026-10-09T00:00:00Z' }),
  ], [
    review('TASK-1', { phase: 'blocked', ...flagged('workflow_exception') }),
    review('TASK-2', { phase: 'done', ...flagged('artifact_drift') }),
  ]);
  assert.equal(flow.stuck.open, 1);
  assert.equal(flow.stuck.needsYou, 2);
  assert.equal(flow.stuck.needsYouClosed, 1);
});

test('byKind chips cover the same runs as needsYou, so a closed run with drift has its chip', () => {
  const flow = build([run('TASK-1', 'blocked'), run('TASK-2', 'completed', { completedAt: '2026-10-09T00:00:00Z' })], [
    review('TASK-1', { phase: 'blocked', ...flagged('workflow_exception') }),
    review('TASK-2', { phase: 'done', ...flagged('artifact_drift') }),
  ]);
  assert.equal(flow.stuck.byKind.reduce((n, k) => n + k.count, 0), flow.stuck.needsYou);
  assert.deepEqual(flow.stuck.byKind.map((k) => k.kind).sort(), ['artifact_drift', 'workflow_exception']);
});

test('byKind counts runs that need a human per Action Center kind, most frequent first', () => {
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
  // Shape changed 2026-10-16 (operator chose A): one median mixed same-day work with
  // backlog clean-up (median 0d, p90 57d), so fresh work and backlog report apart.
  assert.deepEqual(flow.throughput.cycle, { sample: 2, timed: 0, fresh: { count: 1, medianHours: 48, p90Hours: 48 }, backlog: { count: 1, oldestDays: 42 } });
  assert.equal(flow.throughput.days.length, 7);
  // Days carry aborted too since 2026-10-16 (aborted runs were invisible in throughput).
  assert.deepEqual(flow.throughput.days.at(-1), { date: '2026-10-14', opened: 1, closed: 0, aborted: 0 });
  assert.deepEqual(flow.throughput.days.find((d) => d.date === '2026-10-12'), { date: '2026-10-12', opened: 0, closed: 1, aborted: 0 });
  // TASK-4 was cancelled (aborted) inside the window: not closed, but counted apart.
  assert.equal(flow.throughput.aborted, 1);
  assert.deepEqual(flow.throughput.days.find((d) => d.date === '2026-10-11'), { date: '2026-10-11', opened: 1, closed: 0, aborted: 1 });
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

test('movers count a row once by its role and once by its operator field', () => {
  const histories = new Map<string, HistoryEntry[]>([
    ['TASK-1', [
      { phase: 'assigned -> in_review', agent: 'dev', operator: 'codex', at: '2026-10-13T00:00:00Z' },
      { phase: 'in_review -> done', agent: 'reviewer', operator: 'claude', at: '2026-10-14T00:00:00Z' },
    ]],
    ['TASK-2', [{ phase: 'assigned -> in_review', agent: 'dev', at: '2026-10-13T00:00:00Z' }]],
  ]);
  const flow = build([], [], histories);
  assert.deepEqual(flow.movers.roles.map((m) => [m.actor, m.transitions]), [['dev', 2], ['reviewer', 1]]);
  assert.deepEqual(flow.movers.conductors.map((m) => [m.actor, m.transitions]), [['claude', 1], ['codex', 1]]);
  assert.equal(flow.movers.runsWithTransitions, 2);
  assert.equal(flow.movers.runsWithConductor, 1);
});

test('cycle time uses history timestamps, so same-day work reads in hours instead of 0d', () => {
  // 2026-10-16: created_at/completed_at are dates, so 16 of 32 closes read 0d; history has the times.
  const histories = new Map<string, HistoryEntry[]>([
    ['TASK-1', [
      { phase: 'created -> assigned', agent: 'pm', at: '2026-10-09T20:25:37Z' },
      { phase: 'assigned -> done', agent: 'dev', at: '2026-10-09T20:34:51Z' },
    ]],
    ['TASK-2', [
      { phase: 'created -> assigned', agent: 'pm', at: '2026-10-12T17:18:05Z' },
      { phase: 'in_review -> done', agent: 'reviewer', at: '2026-10-12T20:18:05Z' },
    ]],
    // History rewritten long after creation: its first entry is not the start.
    ['TASK-3', [{ phase: 'blocked -> done', agent: 'pm', at: '2026-10-12T10:00:00Z' }]],
  ]);
  const flow = build([
    run('TASK-1', 'completed', { startedAt: '2026-10-10', completedAt: '2026-10-10' }),
    run('TASK-2', 'completed', { startedAt: '2026-10-13', completedAt: '2026-10-13' }),
    run('TASK-3', 'completed', { startedAt: '2026-08-01', completedAt: '2026-10-12' }),
  ], [], histories);
  assert.equal(flow.throughput.cycle.sample, 3);
  assert.equal(flow.throughput.cycle.timed, 2);
  assert.deepEqual(flow.throughput.cycle.fresh, { count: 2, medianHours: 0.2, p90Hours: 3 });
  assert.deepEqual(flow.throughput.cycle.backlog, { count: 1, oldestDays: 72 });
});

test('movers count real phase changes; task openings are reported apart and same-phase notes are not moves', () => {
  // 2026-10-16: pm read 52 "moves" — 31 were openings and 11 were blocked -> blocked notes.
  const histories = new Map<string, HistoryEntry[]>([
    ['TASK-1', [
      { phase: 'created -> assigned', agent: 'pm', at: '2026-10-13T00:00:00Z' },
      { phase: 'blocked -> blocked', agent: 'pm', at: '2026-10-13T01:00:00Z' },
      { phase: 'assigned -> in_review', agent: 'dev', at: '2026-10-13T02:00:00Z' },
    ]],
    ['TASK-2', [
      { phase: 'created -> assigned', agent: 'claude', at: '2026-10-13T00:00:00Z' },
      { phase: 'in_review -> in_review', agent: 'reviewer', at: '2026-10-13T03:00:00Z' },
    ]],
  ]);
  const flow = build([], [], histories);
  assert.deepEqual(flow.movers.roles.map((m) => [m.actor, m.transitions, m.opened]), [['dev', 1, 0], ['pm', 0, 1]]);
  assert.deepEqual(flow.movers.conductors.map((m) => [m.actor, m.transitions, m.opened]), [['claude', 0, 1]]);
  assert.equal(flow.movers.opened, 2);
  assert.equal(flow.movers.samePhaseUpdates, 2);
  assert.equal(flow.movers.runsWithTransitions, 1);
});

test('days and date-only fields are the office local (Bangkok) dates, so a run opened after local midnight counts today', () => {
  // 2026-10-17 02:00 ICT = 2026-10-16T19:00Z: TASK-VS-039 (created_at 2026-10-17) was not counted
  // as opened and the last bar read 10-16, because dates were bucketed in UTC.
  const flow = buildFlowInsights({
    runs: [run('TASK-VS-039', 'running', { startedAt: '2026-10-17' }), run('TASK-1', 'completed', { startedAt: '2026-10-16', completedAt: '2026-10-16T18:30:00Z' })],
    reviews: [], histories: new Map(), now: new Date('2026-10-16T19:00:00Z'), windowDays: 7,
  });
  assert.equal(flow.throughput.opened, 2);
  assert.deepEqual(flow.throughput.days.at(-1), { date: '2026-10-17', opened: 1, closed: 1, aborted: 0 });
});

test('the window starts at local midnight of the first bar, so counts always equal the sum of the bars', () => {
  // A rolling now-minus-7-days start counted a run timestamped 10-10 10:00 ICT with no 10-10 bar.
  const flow = buildFlowInsights({
    runs: [
      run('TASK-1', 'completed', { startedAt: '2026-10-10', completedAt: '2026-10-10T03:00:00Z' }),
      run('TASK-2', 'completed', { startedAt: '2026-10-11', completedAt: '2026-10-11T03:00:00Z' }),
    ],
    reviews: [], histories: new Map(), now: new Date('2026-10-16T19:00:00Z'), windowDays: 7,
  });
  const sum = (k: 'opened' | 'closed') => flow.throughput.days.reduce((n, d) => n + d[k], 0);
  assert.equal(flow.throughput.days[0].date, '2026-10-11');
  assert.equal(flow.throughput.closed, sum('closed'));
  assert.equal(flow.throughput.opened, sum('opened'));
  assert.equal(flow.throughput.closed, 1);
});

test('a close or abort counts on the local day of its timed history entry, not a date-only completed_at', () => {
  // 2026-10-17: TASK-VS-031 went in_review -> done at 2026-10-16T19:19:49Z (02:19 ICT on 10-17) but
  // its completed_at fell back to updated_at '2026-10-16' (the UTC date), so the 10-17 bar showed it on 10-16.
  const histories = new Map<string, HistoryEntry[]>([
    ['TASK-VS-031', [{ phase: 'created -> assigned', at: '2026-10-15T21:31:49Z' }, { phase: 'in_review -> done', at: '2026-10-16T19:19:49Z' }]],
    ['TASK-VS-030', [{ phase: 'created -> assigned', at: '2026-10-15T21:29:20Z' }, { phase: 'assigned -> aborted', at: '2026-10-16T20:02:49Z' }]],
    ['TASK-VS-035', [{ phase: 'created -> assigned', at: '2026-10-16T11:10:57Z' }, { phase: 'in_review -> done', at: '2026-10-16T12:26:08Z' }]],
  ]);
  const flow = buildFlowInsights({
    runs: [
      run('TASK-VS-031', 'completed', { startedAt: '2026-10-16', completedAt: '2026-10-16', updatedAt: '2026-10-16' }),
      run('TASK-VS-030', 'cancelled', { startedAt: '2026-10-16', completedAt: '2026-10-16', updatedAt: '2026-10-16' }),
      run('TASK-VS-035', 'completed', { startedAt: '2026-10-16', completedAt: '2026-10-16', updatedAt: '2026-10-16' }),
    ],
    reviews: [], histories, now: new Date('2026-10-16T21:00:00Z'), windowDays: 7,
  });
  assert.deepEqual(flow.throughput.days.at(-1), { date: '2026-10-17', opened: 0, closed: 1, aborted: 1 });
  assert.deepEqual(flow.throughput.days.at(-2), { date: '2026-10-16', opened: 3, closed: 1, aborted: 0 });
});

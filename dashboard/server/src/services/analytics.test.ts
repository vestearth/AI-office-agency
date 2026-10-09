import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, buildTrends, buildFailures, buildLongRunning, normalizeFailureReason } from './analytics';
import type { RunSummary } from '@shared/types';
import {
  allCompletedRunsFixture,
  mixedWarningRunsFixture,
  degradedErrorRunsFixture,
  runningThresholdFixture,
  failureReasonVariantsFixture,
} from './analytics.fixtures';

const FIXTURE_NOW = '2026-06-02T00:00:00.000Z';

function normalizeHealthFactors<T extends { impact: number }>(factors: T[]): T[] {
  return factors.map((factor) => ({
    ...factor,
    impact: Object.is(factor.impact, -0) ? 0 : factor.impact,
  }));
}

test('normalizeFailureReason groups only safe formatting variants', () => {
  assert.equal(normalizeFailureReason('Missing ENV.'), 'missing env');
  assert.equal(normalizeFailureReason('missing env'), 'missing env');
  assert.equal(normalizeFailureReason('missing   env'), 'missing env');
  assert.equal(normalizeFailureReason(' missing env '), 'missing env');
  assert.equal(normalizeFailureReason(''), 'unknown');
});

test('normalizeFailureReason does not over-group distinct phrases', () => {
  assert.notEqual(normalizeFailureReason('missing env'), normalizeFailureReason('missing test'));
  assert.notEqual(normalizeFailureReason('missing env'), normalizeFailureReason('missing payload'));
  assert.notEqual(normalizeFailureReason('missing test'), normalizeFailureReason('missing test evidence'));
});

test('buildSummary returns ok for all completed runs', () => {
  const summary = buildSummary(allCompletedRunsFixture, { now: FIXTURE_NOW });

  assert.equal(summary.totalRuns, 1);
  assert.equal(summary.completedRuns, 1);
  assert.equal(summary.failedRuns, 0);
  assert.equal(summary.blockedRuns, 0);
  assert.equal(summary.runningRuns, 0);
  assert.equal(summary.successRate, 1);
  assert.equal(summary.failureRate, 0);
  assert.equal(summary.blockedRate, 0);
  assert.deepEqual({
    ...summary.healthScore,
    factors: normalizeHealthFactors(summary.healthScore.factors),
  }, {
    score: 100,
    status: 'ok',
    factors: [
      { label: 'failure-rate', impact: 0, value: 0, detail: '0 failed runs' },
      { label: 'blocked-rate', impact: 0, value: 0, detail: '0 blocked runs' },
      { label: 'stale-running', impact: 0, value: 0, detail: '0 tasks running > 1h' },
    ],
  });
});

test('buildSummary returns warning for mostly completed runs with a few failures and blocks', () => {
  const summary = buildSummary(mixedWarningRunsFixture, { now: FIXTURE_NOW });

  assert.equal(summary.totalRuns, mixedWarningRunsFixture.length);
  assert.equal(summary.completedRuns, 2);
  assert.equal(summary.failedRuns, 1);
  assert.equal(summary.blockedRuns, 1);
  assert.equal(summary.runningRuns, 0);
  // Success is measured over finished work (2 completed / 3 finished); the
  // blocked run is still open, so it is not counted as a failure.
  assert.equal(summary.successRate, 2 / 3);
  assert.equal(summary.failureRate, 0.25);
  assert.equal(summary.blockedRate, 0.25);
  assert.equal(summary.healthScore.status, 'warning');
  assert.ok(summary.healthScore.score < 100);
  assert.ok(summary.healthScore.score >= 70);
  assert.deepEqual(normalizeHealthFactors(summary.healthScore.factors), [
    { label: 'failure-rate', impact: -11, value: 1, detail: '1 failed runs' },
    { label: 'blocked-rate', impact: -8, value: 1, detail: '1 blocked runs' },
    { label: 'stale-running', impact: 0, value: 0, detail: '0 tasks running > 1h' },
  ]);
});

test('buildSummary returns error when failed and blocked work dominate', () => {
  const summary = buildSummary(degradedErrorRunsFixture, { now: FIXTURE_NOW });

  assert.equal(summary.totalRuns, degradedErrorRunsFixture.length);
  assert.equal(summary.completedRuns, 0);
  assert.equal(summary.failedRuns, 2);
  assert.equal(summary.blockedRuns, 1);
  assert.equal(summary.runningRuns, 0);
  assert.equal(summary.successRate, 0);
  assert.equal(summary.failureRate, 2 / 3);
  assert.equal(summary.blockedRate, 1 / 3);
  assert.equal(summary.healthScore.status, 'error');
  assert.ok(summary.healthScore.score < 70);
  assert.deepEqual(normalizeHealthFactors(summary.healthScore.factors), [
    { label: 'failure-rate', impact: -30, value: 2, detail: '2 failed runs' },
    { label: 'blocked-rate', impact: -10, value: 1, detail: '1 blocked runs' },
    { label: 'stale-running', impact: 0, value: 0, detail: '0 tasks running > 1h' },
  ]);
});

test('buildSummary does not heavily penalize fresh running work', () => {
  const summary = buildSummary([allCompletedRunsFixture[0], runningThresholdFixture[0]], { now: FIXTURE_NOW });

  assert.equal(summary.totalRuns, 2);
  assert.equal(summary.completedRuns, 1);
  assert.equal(summary.runningRuns, 1);
  assert.equal(summary.failedRuns, 0);
  assert.equal(summary.blockedRuns, 0);
  // Fresh running work is not finished, so it does not lower the success rate.
  assert.equal(summary.successRate, 1);
  assert.equal(summary.healthScore.status, 'ok');
  assert.equal(summary.healthScore.score, 100);
  assert.deepEqual(normalizeHealthFactors(summary.healthScore.factors), [
    { label: 'failure-rate', impact: 0, value: 0, detail: '0 failed runs' },
    { label: 'blocked-rate', impact: 0, value: 0, detail: '0 blocked runs' },
    { label: 'stale-running', impact: 0, value: 0, detail: '0 tasks running > 1h' },
  ]);
});

test('buildSummary reports the current open work from all runs, not only the window', () => {
  const windowed = [allCompletedRunsFixture[0]];
  const allRuns = [...windowed, ...mixedWarningRunsFixture, runningThresholdFixture[0],
    { id: 'TASK-900', title: 'unreadable', status: 'unknown' as const, runPath: 'runs/TASK-900' }];
  const summary = buildSummary(windowed, { now: FIXTURE_NOW, currentRuns: allRuns });

  assert.equal(summary.blockedRuns, 0); // the window itself has no blocked run
  assert.deepEqual(summary.current, { activeRuns: 3, blockedRuns: 1, unreadableRuns: 1 });
});

test('buildSummary adds warning pressure for stale running work', () => {
  const freshSummary = buildSummary([allCompletedRunsFixture[0], runningThresholdFixture[0]], { now: FIXTURE_NOW });
  const staleSummary = buildSummary([allCompletedRunsFixture[0], runningThresholdFixture[1]], { now: FIXTURE_NOW });

  assert.equal(staleSummary.totalRuns, 2);
  assert.equal(staleSummary.completedRuns, 1);
  assert.equal(staleSummary.runningRuns, 1);
  assert.equal(staleSummary.failedRuns, 0);
  assert.equal(staleSummary.blockedRuns, 0);
  assert.equal(staleSummary.healthScore.status, 'warning');
  assert.ok(staleSummary.healthScore.score < freshSummary.healthScore.score);
  assert.deepEqual(normalizeHealthFactors(staleSummary.healthScore.factors), [
    { label: 'failure-rate', impact: 0, value: 0, detail: '0 failed runs' },
    { label: 'blocked-rate', impact: 0, value: 0, detail: '0 blocked runs' },
    { label: 'stale-running', impact: -13, value: 1, detail: '1 tasks running > 1h' },
  ]);
});

test('buildSummary treats 3600 seconds as fresh and 3601 seconds as stale', () => {
  const atThreshold: RunSummary = {
    ...runningThresholdFixture[0],
    id: 'TASK-402',
    title: 'threshold running',
    durationSeconds: 3600,
  };
  const aboveThreshold: RunSummary = {
    ...runningThresholdFixture[0],
    id: 'TASK-403',
    title: 'above threshold running',
    durationSeconds: 3601,
  };

  const atThresholdSummary = buildSummary([allCompletedRunsFixture[0], atThreshold], { now: FIXTURE_NOW });
  const aboveThresholdSummary = buildSummary([allCompletedRunsFixture[0], aboveThreshold], { now: FIXTURE_NOW });

  assert.equal(atThresholdSummary.healthScore.status, 'ok');
  assert.equal(atThresholdSummary.healthScore.score, 100);
  assert.deepEqual(normalizeHealthFactors(atThresholdSummary.healthScore.factors), [
    { label: 'failure-rate', impact: 0, value: 0, detail: '0 failed runs' },
    { label: 'blocked-rate', impact: 0, value: 0, detail: '0 blocked runs' },
    { label: 'stale-running', impact: 0, value: 0, detail: '0 tasks running > 1h' },
  ]);

  assert.equal(aboveThresholdSummary.healthScore.status, 'warning');
  assert.equal(aboveThresholdSummary.healthScore.score, 87);
  assert.deepEqual(normalizeHealthFactors(aboveThresholdSummary.healthScore.factors), [
    { label: 'failure-rate', impact: 0, value: 0, detail: '0 failed runs' },
    { label: 'blocked-rate', impact: 0, value: 0, detail: '0 blocked runs' },
    { label: 'stale-running', impact: -13, value: 1, detail: '1 tasks running > 1h' },
  ]);
});

test('buildSummary pins health status thresholds at 90 and 70', () => {
  const okAtNinety = buildSummary([
    allCompletedRunsFixture[0],
    { ...allCompletedRunsFixture[0], id: 'TASK-110', title: 'completed two', runPath: 'runs/TASK-110' },
    {
      ...mixedWarningRunsFixture[2],
      id: 'TASK-210',
      title: 'single blocked threshold case',
      runPath: 'runs/TASK-210',
    },
  ], { now: FIXTURE_NOW });
  const warningAtEightyNine = buildSummary([
    allCompletedRunsFixture[0],
    { ...allCompletedRunsFixture[0], id: 'TASK-111', title: 'completed three', runPath: 'runs/TASK-111' },
    { ...allCompletedRunsFixture[0], id: 'TASK-112', title: 'completed four', runPath: 'runs/TASK-112' },
    {
      ...mixedWarningRunsFixture[3],
      id: 'TASK-211',
      title: 'single failed threshold case',
      runPath: 'runs/TASK-211',
    },
  ], { now: FIXTURE_NOW });
  const warningAtSeventy = buildSummary([
    {
      ...degradedErrorRunsFixture[0],
      id: 'TASK-310',
      title: 'failed threshold one',
      runPath: 'runs/TASK-310',
    },
    {
      ...degradedErrorRunsFixture[2],
      id: 'TASK-311',
      title: 'failed threshold two',
      runPath: 'runs/TASK-311',
    },
    {
      ...allCompletedRunsFixture[0],
      id: 'TASK-113',
      title: 'completed threshold support',
      runPath: 'runs/TASK-113',
    },
  ], { now: FIXTURE_NOW });
  const errorAtSixtyNine = buildSummary([
    {
      ...degradedErrorRunsFixture[0],
      id: 'TASK-312',
      title: 'failed threshold three',
      runPath: 'runs/TASK-312',
    },
    {
      ...degradedErrorRunsFixture[2],
      id: 'TASK-313',
      title: 'failed threshold four',
      runPath: 'runs/TASK-313',
    },
    {
      ...mixedWarningRunsFixture[2],
      id: 'TASK-212',
      title: 'blocked threshold support',
      runPath: 'runs/TASK-212',
    },
    {
      ...allCompletedRunsFixture[0],
      id: 'TASK-114',
      title: 'completed threshold support two',
      runPath: 'runs/TASK-114',
    },
  ], { now: FIXTURE_NOW });

  assert.equal(okAtNinety.healthScore.score, 90);
  assert.equal(okAtNinety.healthScore.status, 'ok');
  assert.equal(warningAtEightyNine.healthScore.score, 89);
  assert.equal(warningAtEightyNine.healthScore.status, 'warning');
  assert.equal(warningAtSeventy.healthScore.score, 70);
  assert.equal(warningAtSeventy.healthScore.status, 'warning');
  assert.equal(errorAtSixtyNine.healthScore.score, 69);
  assert.equal(errorAtSixtyNine.healthScore.status, 'error');
});

test('buildTrends calculates daily trend buckets', () => {
  const runs: RunSummary[] = [
    {
      id: 'TASK-001',
      title: 'ok',
      status: 'completed',
      startedAt: '2026-05-31T10:00:00.000Z',
      updatedAt: '2026-05-31T10:00:00.000Z',
      runPath: 'runs/TASK-001',
      normalizedReason: 'unknown',
    },
    {
      id: 'TASK-002',
      title: 'blocked',
      status: 'blocked',
      startedAt: '2026-05-31T11:00:00.000Z',
      updatedAt: '2026-05-31T11:00:00.000Z',
      runPath: 'runs/TASK-002',
      normalizedReason: 'missing env',
    },
    {
      id: 'TASK-003',
      title: 'failed',
      status: 'failed',
      startedAt: '2026-06-01T09:00:00.000Z',
      updatedAt: '2026-06-01T09:00:00.000Z',
      runPath: 'runs/TASK-003',
      normalizedReason: 'missing payload',
    },
  ];

  const trends = buildTrends(runs, { now: '2026-06-02T00:00:00.000Z', windowDays: 7 });

  assert.deepEqual(
    trends.trends.find(point => point.date === '2026-05-31'),
    { date: '2026-05-31', total: 2, completed: 1, failed: 0, blocked: 1 },
  );
  assert.deepEqual(
    trends.trends.find(point => point.date === '2026-06-01'),
    { date: '2026-06-01', total: 1, completed: 0, failed: 1, blocked: 0 },
  );
});

test('buildFailures groups failure reasons and tracks affected tasks', () => {
  const failures = buildFailures(failureReasonVariantsFixture);
  assert.equal(failures.topFailureReasons[0].reason, 'missing env');
  assert.equal(failures.topFailureReasons[0].count, 2);
  assert.ok(failures.topFailureReasons[0].affectedTasks.includes('TASK-500'));
});

test('buildLongRunning sorts running tasks by duration', () => {
  const longRunning = buildLongRunning(runningThresholdFixture);
  assert.equal(longRunning.tasks[0].id, 'TASK-401');
});

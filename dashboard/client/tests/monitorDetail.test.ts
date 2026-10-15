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
  riskLevel: 'none', latestDecision: null, idle: null, lastTransition: null, waitsOn: [], isReleaseTrain: false, ...over,
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

test('Attention wait groups: by kind and ref, largest first, a task once per group', async () => {
  const { waitGroups } = await import('../src/views/ReviewView.tsx');
  const a = flagged('TASK-EAR-402', { waitsOn: [{ kind: 'prod_run' }] });
  const b = flagged('TASK-EAR-368', { waitsOn: [{ kind: 'prod_run' }] });
  const c = flagged('TASK-EAR-391', { waitsOn: [{ kind: 'prod_run', ref: 'TASK-EAR-402' }] });
  const d = flagged('TASK-EAR-369', { waitsOn: [{ kind: 'aws_permission' }, { kind: 'aws_permission' }] });
  const groups = waitGroups([a, b, c, d]);
  assert.deepEqual(groups.map((g) => [g.kind, g.ref, g.tasks.map((t) => t.taskId)]), [
    ['prod_run', null, ['TASK-EAR-402', 'TASK-EAR-368']],
    ['prod_run', 'TASK-EAR-402', ['TASK-EAR-391']],
    ['aws_permission', null, ['TASK-EAR-369']],
  ]);
});

const ev = (id: string, action: string): AgentTimelineEvent => ({ id, agent: 'pm', agentKind: 'role', action, timestamp: '2026-10-15' });

test('timelinePreview folds consecutive metadata rows and always reaches the latest hand-off', async () => {
  const { timelinePreview } = await import('../src/views/monitorDetail.ts');
  // Oldest first, as the server sends it (TASK-EAR-406's shape).
  const all = [
    ev('h1', 'created -> assigned'),
    ev('g1', 'gate deploy_production: absent -> pending'), ev('g2', 'gate production_acceptance: absent -> pending'),
    ev('c1', 'carries: +TASK-EAR-396'), ev('w1', 'waits_on: +operator_approval'), ev('w2', 'waits_on: +prod_run (TASK-EAR-402)'),
  ];
  const { entries, hidden } = timelinePreview(all, 5);
  assert.deepEqual(entries.map((e) => (e.kind === 'event' ? e.event.id : `meta:${e.events.map((x) => x.id).join(',')}`)), ['meta:w2,w1,c1,g2,g1', 'h1']);
  assert.equal(hidden, 0);
});

test('timelinePreview keeps going past the limit until the first hand-off; plain rows are never folded', async () => {
  const { timelinePreview } = await import('../src/views/monitorDetail.ts');
  const all = [ev('h1', 'pending -> assigned'), ev('n1', 'note without arrow'), ev('g1', 'gate a: absent -> pending'), ev('h2', 'assigned -> in_review'), ev('h3', 'in_review -> debugging')];
  const { entries, hidden } = timelinePreview(all, 2);
  assert.deepEqual(entries.map((e) => (e.kind === 'event' ? e.event.id : 'meta')), ['h3', 'h2']);
  assert.equal(hidden, 3);
  const noHandoff = timelinePreview([ev('g1', 'gate a: absent -> pending')], 5);
  assert.equal(noHandoff.entries.length, 1);
});

test('monitor home: waiting follows Attention order (a grant before a stale task); recent breaks a same-day tie by the last hand-off time', () => {
  const runs = [run('S', '2026-10-15'), run('G', '2026-10-15'), run('X', '2026-10-15')];
  const reviews = new Map([
    ['S', flagged('S', { idle: { days: 20, thresholdDays: 14 }, lastTransition: { agent: 'pm', phase: 'a -> b', reason: null, at: '2026-10-15T01:00:00Z' } })],
    ['G', flagged('G', { actionKind: 'authorization_required', lastTransition: { agent: 'pm', phase: 'a -> b', reason: null, at: '2026-10-15T09:00:00Z' } })],
    ['X', flagged('X', { requiresAction: false, actionKind: null, lastTransition: { agent: 'pm', phase: 'a -> b', reason: null, at: '2026-10-15T05:00:00Z' } })],
  ]);
  const home = monitorHome(runs, reviews, 5);
  assert.deepEqual(home.waiting.map((w) => w.run.id), ['G', 'S']);
  assert.deepEqual(home.recent.map((r) => r.id), ['G', 'X', 'S']);
});

test('timeline orders by time when every row has a full timestamp (out-of-order history), file order otherwise', async () => {
  const { chronological, timelineView } = await import('../src/views/monitorDetail.ts');
  const at = (id: string, timestamp: string): AgentTimelineEvent => ({ id, agent: 'pm', agentKind: 'role', action: `${id} -> x`, timestamp });
  const outOfOrder = [at('newest', '2026-10-14T07:00:52Z'), at('mid', '2026-10-12T07:15:25Z'), at('old', '2026-10-12T07:08:22Z')];
  assert.deepEqual(chronological(outOfOrder).map((e) => e.id), ['old', 'mid', 'newest']);
  assert.deepEqual(timelineView(outOfOrder, false).shown.map((e) => e.id), ['newest', 'mid', 'old']);
  const dateOnly = [at('a', '2026-10-12'), at('b', '2026-10-12T07:00:00Z')];
  assert.deepEqual(chronological(dateOnly).map((e) => e.id), ['a', 'b'], 'any date-only row keeps file order');
});

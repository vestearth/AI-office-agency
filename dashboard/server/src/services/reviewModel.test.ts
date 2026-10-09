import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { execFileSync } from 'node:child_process';
import { buildReviewSummary, ReviewModelService } from './reviewModel';
import { GateViewService } from './gateView';
import type { GateEntry, GateView } from '@shared/types';

test('approved + done: not in queue, no attention, not needsReview', () => {
  const r = buildReviewSummary('TASK-001', { phase: 'done', updated_at: '2026-06-01' }, { review_verdict: 'approved' });
  assert.equal(r.phase, 'done');
  assert.equal(r.verdict, 'approved');
  assert.equal(r.inReviewQueue, false);
  assert.equal(r.verdictNeedsAttention, false);
  assert.equal(r.needsReview, false);
  assert.equal(r.requiresAction, false);
  assert.equal(r.actionKind, null);
  assert.equal(r.lastReviewedAt, '2026-06-01');
});

test('in_review phase: in queue and needsReview, even without a verdict yet', () => {
  const r = buildReviewSummary('TASK-002', { phase: 'in_review' }, null);
  assert.equal(r.verdict, null);
  assert.equal(r.inReviewQueue, true);
  assert.equal(r.verdictNeedsAttention, false);
  assert.equal(r.needsReview, true);
  assert.equal(r.requiresAction, true);
  assert.equal(r.actionKind, 'awaiting_review');
  assert.equal(r.lastReviewedAt, null); // no reviewer-output yet
});

test('changes_requested verdict outside its remediation phase is artifact drift, not review', () => {
  const r = buildReviewSummary('TASK-003', { phase: 'debugging', updated_at: '2026-06-02' }, { review_verdict: 'changes_requested' });
  assert.equal(r.inReviewQueue, false);
  assert.equal(r.verdictNeedsAttention, true);
  assert.equal(r.needsReview, false);
  assert.equal(r.requiresAction, true);
  assert.equal(r.actionKind, 'artifact_drift');
});

test('escalate and infra_failure also need attention', () => {
  assert.equal(buildReviewSummary('T', { phase: 'escalated' }, { review_verdict: 'escalate' }).verdictNeedsAttention, true);
  assert.equal(buildReviewSummary('T', { phase: 'devops_needed' }, { review_verdict: 'infra_failure' }).verdictNeedsAttention, true);
  assert.equal(buildReviewSummary('T', { phase: 'escalated' }, { review_verdict: 'escalate' }).actionKind, 'workflow_exception');
  assert.equal(buildReviewSummary('T', { phase: 'devops_needed' }, { review_verdict: 'infra_failure' }).actionKind, 'workflow_exception');
});

test('done with an adverse historical verdict is classified as artifact drift', () => {
  const r = buildReviewSummary('T', { phase: 'done' }, { review_verdict: 'changes_requested' });
  assert.equal(r.needsReview, false);
  assert.equal(r.requiresAction, true);
  assert.equal(r.actionKind, 'artifact_drift');
  assert.match(r.actionReason ?? '', /Task is done/);
});

test('a newer human decision takes precedence as pending reconciliation', () => {
  const decision = { decision: 'approve' as const, actor: 'alice', decidedAt: '2026-06-05T00:00:00Z' };
  const r = buildReviewSummary('T', { phase: 'in_review' }, null, null, decision);
  assert.equal(r.needsReview, false);
  assert.equal(r.decisionPending, true);
  assert.equal(r.actionKind, 'decision_pending');
});

test('an applied human decision is not pending', () => {
  const decision = { decision: 'approve' as const, actor: 'alice', decidedAt: '2026-06-05T00:00:00Z' };
  const r = buildReviewSummary(
    'T',
    { phase: 'done', decision_applied_at: decision.decidedAt },
    { review_verdict: 'approved' },
    null,
    decision,
  );
  assert.equal(r.decisionPending, false);
  assert.equal(r.requiresAction, false);
});

test('blocked and off-contract phases are workflow exceptions', () => {
  assert.equal(buildReviewSummary('T', { phase: 'blocked' }, null).actionKind, 'workflow_exception');
  assert.equal(buildReviewSummary('T', { phase: 'in-review' }, null).actionKind, 'workflow_exception');
});

test('no status / no reviewer output degrades to a safe, empty summary', () => {
  const r = buildReviewSummary('TASK-004', {}, null);
  assert.equal(r.phase, null);
  assert.equal(r.verdict, null);
  assert.equal(r.inReviewQueue, false);
  assert.equal(r.verdictNeedsAttention, false);
  assert.equal(r.needsReview, false);
  assert.equal(r.requiresAction, false);
  assert.equal(r.lastReviewedAt, null);
});

test('unrecognized enum values are dropped to null and surfaced as an exception', () => {
  // A typo or future value must not leak through as a real signal.
  const r = buildReviewSummary('TASK-005', { phase: 'in-review' /* wrong: hyphen */ }, { review_verdict: 'APPROVED' /* wrong case */ });
  assert.equal(r.phase, null);
  assert.equal(r.verdict, null);
  assert.equal(r.needsReview, false);
  assert.equal(r.actionKind, 'workflow_exception');
});

test('lastReviewedAt is null when reviewer output exists but updated_at is absent', () => {
  const r = buildReviewSummary('TASK-006', { phase: 'done' }, { review_verdict: 'approved' });
  assert.equal(r.lastReviewedAt, null);
});

// --- Slice 3: confidence + risk (contract-backed, no prose) ---

test('confidence is projected from debugger diagnosis.confidence (exact enum)', () => {
  const r = buildReviewSummary('T', { phase: 'debugging' }, null, { diagnosis: { confidence: 'high' } });
  assert.equal(r.confidence, 'high');
});

test('confidence is null when no debugger output, and unknown values drop to null', () => {
  assert.equal(buildReviewSummary('T', { phase: 'done' }, null, null).confidence, null);
  assert.equal(buildReviewSummary('T', { phase: 'done' }, null, { diagnosis: { confidence: 'very-sure' } }).confidence, null);
});

test('riskLevel: error issue → high', () => {
  const reviewer = { review_verdict: 'changes_requested', artifacts: [{ issues: [{ severity: 'error', description: 'x' }] }] };
  const r = buildReviewSummary('T', { phase: 'debugging' }, reviewer);
  assert.deepEqual(r.issueCounts, { error: 1, warning: 0, suggestion: 0 });
  assert.equal(r.riskLevel, 'high');
});

test('riskLevel: only warnings → medium; reviewed & clean → low; not reviewed → none', () => {
  const warn = buildReviewSummary('T', { phase: 'done' }, { review_verdict: 'approved', artifacts: [{ issues: [{ severity: 'warning', description: 'x' }] }] });
  assert.equal(warn.riskLevel, 'medium');

  const clean = buildReviewSummary('T', { phase: 'done' }, { review_verdict: 'approved', artifacts: [] });
  assert.equal(clean.riskLevel, 'low');

  const unreviewed = buildReviewSummary('T', { phase: 'in_review' }, null);
  assert.equal(unreviewed.riskLevel, 'none');
  assert.deepEqual(unreviewed.issueCounts, { error: 0, warning: 0, suggestion: 0 });
});

// --- issue #12: reviewer-emitted risk_level is a real producer for riskLevel ---

test('riskLevel: producer risk_level wins when it is higher than the issue-derived level', () => {
  const clean = buildReviewSummary('T', { phase: 'done' }, { review_verdict: 'approved', risk_level: 'high', artifacts: [] });
  assert.equal(clean.riskLevel, 'high');
});

test('riskLevel: a lower producer risk_level never hides a found error', () => {
  const reviewer = { review_verdict: 'changes_requested', risk_level: 'low', artifacts: [{ issues: [{ severity: 'error', description: 'x' }] }] };
  assert.equal(buildReviewSummary('T', { phase: 'debugging' }, reviewer).riskLevel, 'high');
});

test('riskLevel: an absent or off-enum risk_level falls back to the issue-derived level', () => {
  assert.equal(buildReviewSummary('T', { phase: 'done' }, { review_verdict: 'approved', artifacts: [] }).riskLevel, 'low');
  assert.equal(buildReviewSummary('T', { phase: 'done' }, { review_verdict: 'approved', risk_level: 'catastrophic', artifacts: [] }).riskLevel, 'low');
});

test('unknown issue severities are ignored, never guessed', () => {
  const reviewer = { review_verdict: 'approved', artifacts: [{ issues: [{ severity: 'critical' }, { severity: 'error' }] }] };
  const r = buildReviewSummary('T', { phase: 'done' }, reviewer);
  assert.deepEqual(r.issueCounts, { error: 1, warning: 0, suggestion: 0 });
});

// --- Slice 4: human decision surfaced in the read model ---

test('latestDecision defaults to null and is passed through when present', () => {
  assert.equal(buildReviewSummary('T', { phase: 'done' }, null).latestDecision, null);

  const decision = { decision: 'approve' as const, actor: 'alice', decidedAt: '2026-06-05T00:00:00Z' };
  const r = buildReviewSummary('T', { phase: 'done' }, null, null, decision);
  assert.deepEqual(r.latestDecision, decision);
});

test('getReviewSummaries lists only strict TASK ids (parity with detail/decision endpoints)', async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-filter-'));
  for (const name of ['TASK-001', 'TASK-PKG-002', 'TASKbad', 'TASK', 'TASK-001.bak', 'notes', '.hidden']) {
    await fs.mkdir(path.join(runsDir, name), { recursive: true });
    await fs.writeFile(path.join(runsDir, name, 'status.yaml'), yaml.dump({ phase: 'done' }));
  }
  const summaries = await new ReviewModelService(runsDir).getReviewSummaries();
  const ids = summaries.map((s) => s.taskId).sort();
  assert.deepEqual(ids, ['TASK-001', 'TASK-PKG-002']); // loose "TASK*" dirs excluded
});

test('getReviewSummaries titles a task from task.md, then pm-output, when status.yaml has no task_label', async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-title-'));
  await fs.mkdir(path.join(runsDir, 'TASK-001'));
  await fs.writeFile(path.join(runsDir, 'TASK-001', 'status.yaml'), yaml.dump({ phase: 'in_review' }));
  await fs.writeFile(path.join(runsDir, 'TASK-001', 'task.md'), '# TASK-001 — From task.md\n');
  await fs.mkdir(path.join(runsDir, 'TASK-002'));
  await fs.writeFile(path.join(runsDir, 'TASK-002', 'status.yaml'), yaml.dump({ phase: 'in_review' }));
  await fs.writeFile(path.join(runsDir, 'TASK-002', 'pm-output.yaml'), yaml.dump({ task: { title: 'From pm-output' } }));

  const summaries = await new ReviewModelService(runsDir).getReviewSummaries();
  const byId = Object.fromEntries(summaries.map((s) => [s.taskId, s.title]));
  assert.deepEqual(byId, { 'TASK-001': 'From task.md', 'TASK-002': 'From pm-output' });
});

// --- Issue #28 Phase 2F: completion gates in the Action Center ---

type GateFixture = Partial<GateEntry> & { name: string };
function gateView(entries: GateFixture[], extra: Partial<GateView> = {}): GateView {
  const gates: GateEntry[] = entries.map((entry) => ({
    status: 'pending', resolved: false, waitsOn: [], requiresAuthorization: null, grant: null,
    requiresRecord: false, ran: null, passable: true, unresolvedReason: null, detail: 'can pass now', ...entry,
  }));
  return {
    readable: true, problem: null, finishedPhase: null,
    summary: {
      total: gates.length,
      resolved: gates.filter((gate) => gate.resolved).length,
      passable: gates.filter((gate) => gate.passable).length,
      byStatus: {},
    },
    gates,
    ...extra,
  };
}
const BOUND_MISSING: GateFixture = {
  name: 'deploy', requiresAuthorization: 'deploy_staging', grant: 'missing', passable: false,
  detail: 'waits for a deploy_staging grant',
};

test('a bound gate that only waits for a grant is authorization_required, with the grant command', () => {
  const r = buildReviewSummary('TASK-EAR-1', { phase: 'assigned' }, null, null, null, gateView([BOUND_MISSING]));
  assert.equal(r.actionKind, 'authorization_required');
  assert.equal(r.requiresAction, true);
  assert.equal(r.needsReview, false);
  assert.equal(r.actionReason, 'Gate deploy waits for a deploy_staging grant.');
  assert.equal(
    r.recommendedAction,
    'ruby scripts/record-authorization.rb TASK-EAR-1 grant --action deploy_staging --scope <scope> --actor <you> --via <channel> --reason "<why>"',
  );
  assert.deepEqual(r.gates, { readable: true, total: 1, resolved: 0, passable: 0 });
});

test('several gates waiting for grants are all named', () => {
  const r = buildReviewSummary('T', { phase: 'assigned' }, null, null, null, gateView([
    BOUND_MISSING,
    { ...BOUND_MISSING, name: 'backfill', requiresAuthorization: 'production_backfill' },
  ]));
  assert.equal(r.actionReason, 'Gate deploy waits for a deploy_staging grant; Gate backfill waits for a production_backfill grant.');
});

test('a bound gate still waiting on another gate is not flagged yet', () => {
  const r = buildReviewSummary('T', { phase: 'assigned' }, null, null, null, gateView([
    { name: 'verify' },
    { ...BOUND_MISSING, waitsOn: ['verify (pending)'] },
  ]));
  assert.equal(r.actionKind, null);
});

test('a finished task gets no gate kind', () => {
  const view = gateView([{ ...BOUND_MISSING, detail: 'task is done' }], { finishedPhase: 'done' });
  const r = buildReviewSummary('T', { phase: 'done' }, { review_verdict: 'approved' }, null, null, view);
  assert.equal(r.actionKind, null);
});

test('an unreadable gate view is gates_unreadable, with the problem', () => {
  const view = gateView([], { readable: false, problem: 'completion_gates is not a map' });
  const r = buildReviewSummary('TASK-9', { phase: 'assigned' }, null, null, null, view);
  assert.equal(r.actionKind, 'gates_unreadable');
  assert.equal(r.actionReason, 'Gate state cannot be read: completion_gates is not a map.');
  assert.equal(r.recommendedAction, 'Run ./run-agent.sh status TASK-9 and repair status.yaml / authorization.yaml through their writers.');
  assert.deepEqual(r.gates, { readable: false, total: 0, resolved: 0, passable: 0 });
});

test('an unreadable authorization ledger is gates_unreadable, whether the gate is pending or passed', () => {
  const pending = gateView([{ ...BOUND_MISSING, grant: 'unknown' }]);
  const passed = gateView([{ name: 'deploy', status: 'pass', passable: false, unresolvedReason: 'authorization ledger unreadable' }]);
  for (const view of [pending, passed]) {
    const r = buildReviewSummary('T', { phase: 'assigned' }, null, null, null, view);
    assert.equal(r.actionKind, 'gates_unreadable');
    assert.equal(r.actionReason, 'Gate state cannot be read: the authorization ledger cannot be read.');
  }
});

test('an approved review held by unresolved gates is completion_held, not awaiting_review', () => {
  const view = gateView([
    { name: 'verify', status: 'pass', resolved: true, passable: false, detail: '' },
    { name: 'smoke', detail: 'can pass now' },
    { name: 'publish', passable: false, waitsOn: ['smoke (pending)'], detail: 'waits on smoke (pending)' },
  ]);
  const r = buildReviewSummary('TASK-7', { phase: 'in_review' }, { review_verdict: 'approved' }, null, null, view);
  assert.equal(r.actionKind, 'completion_held');
  assert.equal(r.needsReview, false);
  assert.equal(r.inReviewQueue, true);
  assert.equal(r.actionReason, 'Review approved; the done guard holds the task until its gates resolve: smoke: can pass now; publish: waits on smoke (pending).');
  assert.equal(r.recommendedAction, 'Dispatch the role that owns the open gates; ./run-agent.sh status TASK-7 shows which can pass now.');
});

test('a review without an approval stays awaiting_review even with open gates', () => {
  const view = gateView([{ name: 'smoke' }]);
  assert.equal(buildReviewSummary('T', { phase: 'in_review' }, null, null, null, view).actionKind, 'awaiting_review');
  assert.equal(buildReviewSummary('T', { phase: 'review' }, { review_verdict: 'changes_requested' }, null, null, view).actionKind, 'awaiting_review');
});

test('gate kinds follow decision_pending, then unreadable, authorization, completion_held', () => {
  const decision = { decision: 'approve' as const, actor: 'alice', decidedAt: '2026-06-05T00:00:00Z' };
  const unreadable = gateView([], { readable: false, problem: 'x' });
  assert.equal(buildReviewSummary('T', { phase: 'in_review' }, null, null, decision, unreadable).actionKind, 'decision_pending');
  const ledgerAndGrant = gateView([{ ...BOUND_MISSING, grant: 'unknown' }, { ...BOUND_MISSING, name: 'other' }]);
  assert.equal(buildReviewSummary('T', { phase: 'assigned' }, null, null, null, ledgerAndGrant).actionKind, 'gates_unreadable');
  const approvedWithGrant = gateView([BOUND_MISSING]);
  assert.equal(buildReviewSummary('T', { phase: 'in_review' }, { review_verdict: 'approved' }, null, null, approvedWithGrant).actionKind, 'authorization_required');
  const blocked = gateView([BOUND_MISSING]);
  assert.equal(buildReviewSummary('T', { phase: 'blocked' }, null, null, null, blocked).actionKind, 'authorization_required');
});

test('without a gate view the summary has no gates key and the old classification', () => {
  const r = buildReviewSummary('T', { phase: 'in_review' }, { review_verdict: 'approved' });
  assert.equal(r.actionKind, 'awaiting_review');
  assert.equal(Object.prototype.hasOwnProperty.call(r, 'gates'), false);
});

test('getReviewSummaries loads a gate view only for tasks with completion_gates', async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-gates-'));
  const statuses: Record<string, Record<string, unknown>> = {
    'TASK-001': { phase: 'assigned' },
    'TASK-002': { phase: 'assigned', completion_gates: { deploy: { status: 'pending' } } },
    'TASK-003': { phase: 'assigned', completion_gates: 'oops' },
  };
  for (const [taskId, status] of Object.entries(statuses)) {
    await fs.mkdir(path.join(runsDir, taskId), { recursive: true });
    await fs.writeFile(path.join(runsDir, taskId, 'status.yaml'), yaml.dump(status));
  }
  const loaded: string[] = [];
  const fake = { load: async (dir: string) => { loaded.push(path.basename(dir)); return gateView([BOUND_MISSING]); } };
  const summaries = await new ReviewModelService(runsDir, fake as unknown as GateViewService).getReviewSummaries();
  assert.deepEqual(loaded.sort(), ['TASK-002', 'TASK-003']);
  const byId = Object.fromEntries(summaries.map((s) => [s.taskId, s]));
  assert.equal(byId['TASK-001'].actionKind, null);
  assert.equal(Object.prototype.hasOwnProperty.call(byId['TASK-001'], 'gates'), false);
  assert.equal(byId['TASK-002'].actionKind, 'authorization_required');
});

test('all gates resolved after an approval is no longer completion_held', () => {
  const view = gateView([{ name: 'smoke', status: 'pass', resolved: true, passable: false, detail: '' }]);
  const r = buildReviewSummary('T', { phase: 'in_review' }, { review_verdict: 'approved' }, null, null, view);
  assert.equal(r.actionKind, 'awaiting_review');
  assert.deepEqual(r.gates, { readable: true, total: 1, resolved: 1, passable: 0 });
});

// Review Focus: the real script and the real writers, end to end.
const OFFICE_ROOT = path.resolve(__dirname, '../../../..');
const governedStatus = (taskId: string) => ({
  task_id: taskId, phase: 'assigned', state: 'assigned', iteration: 1, current_agent: 'dev', ready: true,
  blocked_on: [], waiting_for: [], assignment: { primary: 'dev', parallel: false }, updated_at: '2026-10-01', history: [],
});
function office(runsDir: string, script: string, ...args: string[]): void {
  const env: NodeJS.ProcessEnv = { ...process.env, AI_OFFICE_RUNS_DIR: runsDir };
  delete env.AI_OFFICE_NOW;
  execFileSync('ruby', [path.join(OFFICE_ROOT, 'scripts', script), ...args], { env, stdio: 'pipe' });
}

test('a grant recorded between two reads changes the kind: nothing is cached', async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-grant-'));
  await fs.mkdir(path.join(runsDir, 'TASK-001'));
  await fs.writeFile(path.join(runsDir, 'TASK-001', 'status.yaml'), yaml.dump(governedStatus('TASK-001')));
  office(runsDir, 'update-completion-gate.rb', 'TASK-001', 'declare', 'deploy', '--actor', 'pm', '--reason', 'd', '--requires-authorization', 'deploy_staging');
  const service = new ReviewModelService(runsDir, new GateViewService(path.join(OFFICE_ROOT, 'scripts', 'gate-view-json.rb')));
  const before = (await service.getReviewSummaries())[0];
  assert.equal(before.actionKind, 'authorization_required', before.actionReason ?? '');
  office(runsDir, 'record-authorization.rb', 'TASK-001', 'grant', '--action', 'deploy_staging', '--scope', 'staging', '--actor', 'operator', '--via', 'chat', '--reason', 'ok');
  const after = (await service.getReviewSummaries())[0];
  assert.equal(after.actionKind, null);
  assert.deepEqual(after.gates, { readable: true, total: 1, resolved: 0, passable: 1 });
});

test('25 gated tasks read at once all come back readable', async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-many-'));
  const gates = { smoke: { status: 'pending', actor: 'pm', reason: 's', updated_at: '2026-10-08T01:00:00Z' } };
  for (let i = 1; i <= 25; i += 1) {
    const taskId = `TASK-${String(i).padStart(3, '0')}`;
    await fs.mkdir(path.join(runsDir, taskId));
    await fs.writeFile(path.join(runsDir, taskId, 'status.yaml'), yaml.dump({ ...governedStatus(taskId), completion_gates: gates }));
  }
  const service = new ReviewModelService(runsDir, new GateViewService(path.join(OFFICE_ROOT, 'scripts', 'gate-view-json.rb')));
  const summaries = await service.getReviewSummaries();
  assert.equal(summaries.length, 25);
  for (const summary of summaries) {
    assert.deepEqual(summary.gates, { readable: true, total: 1, resolved: 0, passable: 1 }, summary.taskId);
  }
});

test('a finished task is never flagged by gates, even when its gate state cannot be read', () => {
  const ledger = gateView([{ name: 'deploy', status: 'pass', passable: false, unresolvedReason: 'authorization ledger unreadable' }]);
  const done = buildReviewSummary('T', { phase: 'done' }, { review_verdict: 'approved' }, null, null, ledger);
  assert.equal(done.actionKind, null);
  assert.deepEqual(done.gates, { readable: true, total: 1, resolved: 0, passable: 0 });
  const broken = gateView([], { readable: false, problem: 'completion_gates is not a map' });
  const aborted = buildReviewSummary('T', { phase: 'aborted' }, null, null, null, broken);
  assert.equal(aborted.actionKind, null);
  assert.deepEqual(aborted.gates, { readable: false, total: 0, resolved: 0, passable: 0 });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { buildReviewSummary, ReviewModelService } from './reviewModel';

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

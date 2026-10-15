import test from 'node:test';
import assert from 'node:assert/strict';
import type { KnowledgeReviewDetail, KnowledgeReviewFinding } from '@shared/types';
import { buildOpenFindings, buildRecheckBrief, needsHumanDecision, noteFolder, normalizeNotePath, policyPathPatterns } from './knowledgeReviews';

const finding = (fingerprint: string, over: Partial<KnowledgeReviewFinding> = {}): KnowledgeReviewFinding => ({
  fingerprint, notePath: 'Knowledge Base/10 Projects/VerifySlip/Admin Bank Flows.md', question: `${fingerprint}?`,
  issueType: 'stale', status: 'new', priority: 'medium', evidenceState: 'partial', verificationScope: 'note',
  sources: [], recommendedAction: 'update_note', closureCriteria: 'The note cites the current source.', answer: '', confidence: 'medium', ...over,
});

const review = (reviewId: string, generatedAt: string, findings: KnowledgeReviewFinding[]): KnowledgeReviewDetail => ({
  reviewId, generatedAt, scope: { product: 'x', paths: [], maxNotes: 1, timeboxMinutes: 10 },
  writeMode: 'proposal_only', reviewMode: 'pre_write', requiresHumanReview: true,
  notesReviewedCount: 1, findingsCount: findings.length, changesCount: 0, appliedChangesCount: 0, summary: '',
  authorization: null, notesReviewed: [], findings, changes: [],
});

test('each fingerprint takes the status of the latest audit that reported it', () => {
  const result = buildOpenFindings([
    // Listed out of order on purpose: the builder must sort by generatedAt.
    review('KLR-20261003T000000Z-b', '2026-10-03T00:00:00Z', [finding('fp-1', { status: 'resolved' }), finding('fp-2', { status: 'recurring', priority: 'high' })]),
    review('KLR-20261001T000000Z-a', '2026-10-01T00:00:00Z', [finding('fp-1'), finding('fp-2'), finding('fp-3', { status: 'suppressed' })]),
    review('KLR-20261005T000000Z-c', '2026-10-05T00:00:00Z', [finding('fp-4', { priority: 'critical' })]),
  ]);
  assert.deepEqual(result.totals, { fingerprints: 4, open: 2, resolved: 1, suppressed: 1 });
  assert.deepEqual(result.items.map((f) => f.fingerprint), ['fp-4', 'fp-2']);
  const fp2 = result.items.find((f) => f.fingerprint === 'fp-2')!;
  assert.equal(fp2.timesReported, 2);
  assert.equal(fp2.firstReportedAt, '2026-10-01T00:00:00Z');
  assert.equal(fp2.lastReportedAt, '2026-10-03T00:00:00Z');
  assert.equal(fp2.reviewId, 'KLR-20261003T000000Z-b');
  assert.equal(fp2.priority, 'high');
});

test('a finding reopened after being resolved counts as open again', () => {
  const result = buildOpenFindings([
    review('KLR-20261001T000000Z-a', '2026-10-01T00:00:00Z', [finding('fp-1', { status: 'resolved' })]),
    review('KLR-20261002T000000Z-b', '2026-10-02T00:00:00Z', [finding('fp-1', { status: 'recurring' })]),
  ]);
  assert.equal(result.totals.open, 1);
  assert.equal(result.items[0].status, 'recurring');
});

test('note paths fold the knowledge-base repo prefix into the vault and group by folder', () => {
  assert.equal(normalizeNotePath('knowledge-base/Knowledge Base/Review Queue.md'), 'Knowledge Base/Review Queue.md');
  assert.equal(normalizeNotePath('jaview/Knowledge Base/x.md'), 'jaview/Knowledge Base/x.md');
  assert.equal(noteFolder('Knowledge Base/10 Projects/VerifySlip/Admin Bank Flows.md'), '10 Projects/VerifySlip');
  assert.equal(noteFolder('knowledge-base/Knowledge Base/10 Projects/Games Labs Order/sub/deep/x.md'), '10 Projects/Games Labs Order');
  assert.equal(noteFolder('Knowledge Base/Review Queue.md'), 'Knowledge Base');
  assert.equal(noteFolder('ai-dev-office/runs/TASK-EAR-363/status.yaml'), 'ai-dev-office/runs');
  assert.equal(noteFolder('README.md'), '(no folder)');
});

test('needsHumanDecision: append_review_queue plus a human-decision fingerprint or closure criterion', () => {
  const base = { recommendedAction: 'append_review_queue', fingerprint: 'x', closureCriteria: 'Operator confirms the datasource.' };
  assert.equal(needsHumanDecision(base), false);
  assert.equal(needsHumanDecision({ ...base, fingerprint: 'games-labs:human-decision:spend-category' }), true);
  assert.equal(needsHumanDecision({ ...base, closureCriteria: 'A human product/architecture decision defines the categories.' }), true);
  assert.equal(needsHumanDecision({ ...base, closureCriteria: 'A human-approved implementation defines the API values.' }), true);
  assert.equal(needsHumanDecision({ ...base, recommendedAction: 'update_note', fingerprint: 'games-labs:human-decision:x' }), false);
});

test('needsHumanDecision: no_change whose closure criterion names a human actor and act', () => {
  const nc = (closureCriteria: string) => needsHumanDecision({ recommendedAction: 'no_change', fingerprint: 'x', closureCriteria });
  assert.equal(nc('Human applies or rejects the existing tracker patch after correcting its wording.'), true);
  assert.equal(nc('A human evaluates ADR-0002 at Weekly Review and explicitly accepts it.'), true);
  assert.equal(nc('The credential owner revokes the credential and records its scope.'), true);
  assert.equal(nc('Before any rollout, an operator records whether both cohorts stay.'), true);
  assert.equal(nc('The owning coordinator updates TASK-EAR-363 through the normal workflow.'), true);
  assert.equal(nc('A separately scoped owner determines whether the six files are generator drift.'), true);
  // Evidence or runtime work a later audit can still close on its own.
  assert.equal(nc('Capture only after request-level evidence identifies which call failed.'), false);
  assert.equal(nc('Read WIN_CAPTURE_PROVIDERS from the running Provider prod task after desired > 0.'), false);
  assert.equal(nc('The assigned reviewer records the current rollout state in the task workflow.'), false);
  assert.equal(nc('A separately authorized non-destructive staging setup makes a target level available.'), false);
  assert.equal(needsHumanDecision({ recommendedAction: 'update_note', fingerprint: 'x', closureCriteria: 'Human applies the patch.' }), false);
});

test('open findings carry needsHumanDecision', () => {
  const result = buildOpenFindings([review('KLR-20261001T000000Z-a', '2026-10-01T00:00:00Z', [
    finding('fp-h', { recommendedAction: 'append_review_queue', fingerprint: 'games-labs:human-decision:x' }),
    finding('fp-n'),
  ])]);
  // Same priority and date: fingerprint order is the tie-break.
  assert.deepEqual(result.items.map((f) => [f.fingerprint, f.needsHumanDecision]), [['fp-n', false], ['games-labs:human-decision:x', true]]);
});

const PATTERNS = policyPathPatterns({ scopes: { games_labs: { write_targets: [
  { path_pattern: '\\AKnowledge Base/10 Projects/Games Labs [^/]+/.+\\.md\\z' },
  { path_pattern: '\\AKnowledge Base/Review Queue\\.md\\z' },
] } } });

test('policyPathPatterns converts Ruby anchors and matches the Games Labs scope only', () => {
  assert.equal(PATTERNS.length, 2);
  assert.ok(PATTERNS[0].test('Knowledge Base/10 Projects/Games Labs Order/Redemption.md'));
  assert.ok(!PATTERNS[0].test('Knowledge Base/10 Projects/VerifySlip/Admin.md'));
  assert.ok(PATTERNS[1].test('Knowledge Base/Review Queue.md'));
  assert.deepEqual(policyPathPatterns({}), []);
});

const NOW = new Date('2026-10-15T09:00:00Z');
const openItem = (fingerprint: string, notePath: string, over: Partial<ReturnType<typeof buildOpenFindings>['items'][number]> = {}) => ({
  fingerprint, notePath, folder: 'f', question: `${fingerprint}?`, priority: 'medium' as const, status: 'new' as const,
  evidenceState: 'confirmed' as const, recommendedAction: 'update_note', needsHumanDecision: false, timesReported: 1,
  firstReportedAt: '2026-09-01T00:00:00Z', lastReportedAt: '2026-09-01T00:00:00Z', reviewId: 'KLR-1', closureCriteria: '', ...over,
});

test('task brief: Games Labs scope only, no human decisions, confirmed evidence first, capped per note set', () => {
  const brief = buildRecheckBrief([
    openItem('vs', 'Knowledge Base/10 Projects/VerifySlip/A.md', { priority: 'critical' }),
    openItem('hd', 'Knowledge Base/10 Projects/Games Labs Order/B.md', { priority: 'critical', needsHumanDecision: true }),
    openItem('partial-high', 'Knowledge Base/10 Projects/Games Labs Order/B.md', { priority: 'high', evidenceState: 'partial' }),
    openItem('confirmed-medium', 'Knowledge Base/10 Projects/Games Labs Order/B.md', { priority: 'medium' }),
    openItem('old-low', 'Knowledge Base/Review Queue.md', { priority: 'low', lastReportedAt: '2026-07-01T00:00:00Z' }),
  ], 275, { audience: 'task', scopePatterns: PATTERNS, now: NOW, maxNotes: 1, maxFindings: 15 });
  assert.equal(brief.considered, 3);
  assert.deepEqual(brief.notes.map((n) => [n.notePath, n.findings.map((f) => f.fingerprint)]), [
    ['Knowledge Base/10 Projects/Games Labs Order/B.md', ['confirmed-medium', 'partial-high']],
  ]);
  assert.equal(brief.remainingNotes, 1);
  assert.match(brief.text, /Apply a proposed patch only when its evidence is still confirmed/);
  assert.match(brief.text, /Scope: 1 note · 2 findings \(of 3 considered, 275 open; 1 more notes wait for the next run\)/);
  assert.match(brief.text, /\[medium\] confirmed-medium — evidence confirmed; last audited 2026-09-01 \(44d\) in KLR-1/);
});

test('human brief: honours the fingerprint filter, keeps every scope, caps findings so a hub note cannot take the run', () => {
  const hub = Array.from({ length: 20 }, (_, i) => openItem(`hub-${i}`, 'Knowledge Base/Review Queue.md', { priority: i < 2 ? 'critical' : 'medium' }));
  const brief = buildRecheckBrief([...hub, openItem('vs', 'Knowledge Base/10 Projects/VerifySlip/A.md', { priority: 'high' })], 275,
    { audience: 'human', fingerprints: [...hub.map((h) => h.fingerprint), 'vs'], now: NOW });
  assert.deepEqual(brief.notes.map((n) => [n.notePath, n.findings.length, n.remaining]), [['Knowledge Base/Review Queue.md', 15, 5]]);
  assert.equal(brief.remainingNotes, 1);
  assert.match(brief.text, /\(\+5 more open on this note for a later run\)/);
  const only = buildRecheckBrief(hub, 275, { audience: 'human', fingerprints: ['hub-3'], now: NOW });
  assert.equal(only.considered, 1);
});

test('human briefs leave out findings only a human can close, and say how many', () => {
  const brief = buildRecheckBrief([
    openItem('decide', 'Knowledge Base/20 Flows/Security.md', { priority: 'critical', needsHumanDecision: true }),
    openItem('edit', 'Knowledge Base/20 Flows/Security.md', { priority: 'high' }),
  ], 2, { audience: 'human', now: NOW });
  assert.deepEqual(brief.notes.flatMap((n) => n.findings.map((f) => f.fingerprint)), ['edit']);
  assert.equal(brief.humanDecisionsExcluded, 1);
  assert.match(brief.text, /Left out: 1 finding only a human can close/);
});

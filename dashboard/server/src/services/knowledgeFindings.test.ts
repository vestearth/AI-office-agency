import test from 'node:test';
import assert from 'node:assert/strict';
import type { KnowledgeReviewDetail, KnowledgeReviewFinding } from '@shared/types';
import { buildOpenFindings, noteFolder, normalizeNotePath } from './knowledgeReviews';

const finding = (fingerprint: string, over: Partial<KnowledgeReviewFinding> = {}): KnowledgeReviewFinding => ({
  fingerprint, notePath: 'Knowledge Base/10 Projects/VerifySlip/Admin Bank Flows.md', question: `${fingerprint}?`,
  issueType: 'stale', status: 'new', priority: 'medium', evidenceState: 'partial', verificationScope: 'note',
  sources: [], recommendedAction: 'update_note', answer: '', confidence: 'medium', ...over,
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

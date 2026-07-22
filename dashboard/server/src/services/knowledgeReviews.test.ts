import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeReviewService, KNOWLEDGE_REVIEW_ID_PATTERN, parseKnowledgeReview } from './knowledgeReviews';

function fixture(reviewId: string, generatedAt: string, disposition: 'proposed' | 'applied' = 'proposed') {
  const autoWrite = disposition === 'applied';
  return `
artifact_type: knowledge_librarian_review
schema_version: 1
review_id: ${reviewId}
generated_at: "${generatedAt}"
scope:
  product: ai-office
  paths: ["Knowledge Base/10 Projects/AI Office Agency/"]
  max_notes: 5
  timebox_minutes: 20
write_mode: ${autoWrite ? 'approved_scope_auto_write' : 'proposal_only'}
review_mode: ${autoWrite ? 'post_write' : 'pre_write'}
authorization: ${autoWrite ? '' : 'null'}
${autoWrite ? '  approved_scope: ai-office\n  policy_source: policy.yaml\n  approved_by: Earth\n  approved_at: "2026-07-21"' : ''}
requires_human_review: true
notes_reviewed: ["Knowledge Base/10 Projects/AI Office Agency/Project Map.md"]
findings:
  - fingerprint: ai-office:test
    note_path: "Knowledge Base/10 Projects/AI Office Agency/Project Map.md"
    question: "Is this current?"
    issue_type: source_drift
    status: new
    priority: medium
    evidence_state: confirmed
    verification_scope: source
    sources: ["ai-dev-office/README.md"]
    recommended_action: update_note
    closure_criteria: "Current repository evidence confirms the answer"
    answer: "Yes"
    opened_at: "2026-07-21T11:00:00Z"
    closed_at: null
    confidence: high
    proposed_patch: "Update the source reference"
changes:
  - note_path: "Knowledge Base/10 Projects/AI Office Agency/Project Map.md"
    target_class: project_note
    action: update
    disposition: ${disposition}
    finding_fingerprint: ai-office:test
    resulting_status: null
    summary: "Update source references"
summary: "Reviewed one note."
`;
}

test('parseKnowledgeReview projects the validated audit fields', () => {
  const review = parseKnowledgeReview(fixture('KLR-20260721T120000Z-ai-office', '2026-07-21T12:00:00Z'));
  assert.equal(review.scope.product, 'ai-office');
  assert.equal(review.notesReviewedCount, 1);
  assert.equal(review.findingsCount, 1);
  assert.equal(review.changesCount, 1);
  assert.equal(review.appliedChangesCount, 0);
});

test('KnowledgeReviewService sorts valid reviews and isolates malformed YAML', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-reviews-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'older.yaml'), fixture('KLR-20260720T120000Z-older', '2026-07-20T12:00:00Z'));
  await fs.writeFile(path.join(dir, 'newer.yaml'), fixture('KLR-20260721T120000Z-newer', '2026-07-21T12:00:00Z', 'applied'));
  await fs.writeFile(path.join(dir, 'broken.yaml'), 'artifact_type: [');

  const service = new KnowledgeReviewService(dir);
  const result = await service.list();

  assert.equal(result.total, 2);
  assert.equal(result.invalidCount, 1);
  assert.deepEqual(result.invalidFiles, ['broken.yaml']);
  assert.equal(result.reviews[0].reviewId, 'KLR-20260721T120000Z-newer');
  assert.equal(result.reviews[0].appliedChangesCount, 1);
  assert.equal((await service.getById('KLR-20260720T120000Z-older'))?.summary, 'Reviewed one note.');
});

test('KnowledgeReviewService returns an empty model when the directory is absent', async () => {
  const service = new KnowledgeReviewService(path.join(os.tmpdir(), `missing-knowledge-reviews-${Date.now()}`));
  const result = await service.list();
  assert.equal(result.total, 0);
  assert.equal(result.invalidCount, 0);
});

test('KnowledgeReviewService quarantines every file that shares a review id', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-review-duplicates-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const duplicate = fixture('KLR-20260721T120000Z-duplicate', '2026-07-21T12:00:00Z');
  await fs.writeFile(path.join(dir, 'first.yaml'), duplicate);
  await fs.writeFile(path.join(dir, 'second.yaml'), duplicate);

  const service = new KnowledgeReviewService(dir);
  const result = await service.list();

  assert.equal(result.total, 0);
  assert.equal(result.invalidCount, 2);
  assert.deepEqual(result.invalidFiles, ['first.yaml', 'second.yaml']);
  assert.equal(await service.getById('KLR-20260721T120000Z-duplicate'), null);
});

test('KnowledgeReviewService verifies applied changes against the workspace authorization policy', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-review-policy-'));
  const dir = path.join(root, 'knowledge-reviews');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(dir);
  await fs.writeFile(path.join(root, 'policy.yaml'), `
version: 1
scopes:
  ai-office:
    approved_by: Earth
    approved_at: "2026-07-21"
    review_mode: post_write
    write_targets:
      - target_class: project_note
        path_pattern: '\\AKnowledge Base/10 Projects/AI Office Agency/.+\\.md\\z'
        actions: [update]
      - target_class: project_note
        path_pattern: '\\AAllowed/\\h+\\.md\\z'
        actions: [update]
`);
  await fs.writeFile(path.join(dir, 'authorized.yaml'), fixture('KLR-20260721T120000Z-authorized', '2026-07-21T12:00:00Z', 'applied'));
  await fs.writeFile(
    path.join(dir, 'outside-policy.yaml'),
    fixture('KLR-20260721T120001Z-outside-policy', '2026-07-21T12:00:01Z', 'applied')
      .split('Knowledge Base/10 Projects/AI Office Agency/Project Map.md')
      .join('Knowledge Base/40 Lessons/Project Map.md'),
  );
  await fs.writeFile(
    path.join(dir, 'ruby-regex-mismatch.yaml'),
    fixture('KLR-20260721T120002Z-ruby-regex-mismatch', '2026-07-21T12:00:02Z', 'applied')
      .split('Knowledge Base/10 Projects/AI Office Agency/Project Map.md')
      .join('Allowed/hhh.md'),
  );

  const result = await new KnowledgeReviewService(dir, root).list();

  assert.equal(result.total, 1);
  assert.equal(result.reviews[0].reviewId, 'KLR-20260721T120000Z-authorized');
  assert.deepEqual(result.invalidFiles, ['outside-policy.yaml', 'ruby-regex-mismatch.yaml']);
});

test('parseKnowledgeReview rejects artifacts that violate bounded scope or write-mode semantics', () => {
  const source = fixture('KLR-20260721T120000Z-invalid', '2026-07-21T12:00:00Z')
    .replace('max_notes: 5', 'max_notes: 6');
  assert.throws(() => parseKnowledgeReview(source), /scope\.max_notes/);

  const appliedProposal = fixture('KLR-20260721T120000Z-invalid-write', '2026-07-21T12:00:00Z')
    .replace('disposition: proposed', 'disposition: applied');
  assert.throws(() => parseKnowledgeReview(appliedProposal), /proposal_only/);
});

test('parseKnowledgeReview requires the full finding contract and known change fingerprints', () => {
  const missingClosure = fixture('KLR-20260721T120000Z-missing-field', '2026-07-21T12:00:00Z')
    .replace('    closure_criteria: "Current repository evidence confirms the answer"\n', '');
  assert.throws(() => parseKnowledgeReview(missingClosure), /closure_criteria/);

  const unknownFingerprint = fixture('KLR-20260721T120000Z-unknown-fingerprint', '2026-07-21T12:00:00Z')
    .replace('finding_fingerprint: ai-office:test', 'finding_fingerprint: ai-office:missing');
  assert.throws(() => parseKnowledgeReview(unknownFingerprint), /unknown finding fingerprint/);
});

test('parseKnowledgeReview rejects impossible ISO date-time components', () => {
  const impossibleDay = fixture('KLR-20260721T120000Z-impossible-day', '2026-02-30T12:00:00Z');
  assert.throws(() => parseKnowledgeReview(impossibleDay), /generated_at must be an ISO date-time/);

  const impossibleHour = fixture('KLR-20260721T120000Z-impossible-hour', '2026-01-01T24:00:00Z');
  assert.throws(() => parseKnowledgeReview(impossibleHour), /generated_at must be an ISO date-time/);
});

test('knowledge review ids reject traversal-shaped input', () => {
  assert.equal(KNOWLEDGE_REVIEW_ID_PATTERN.test('KLR-20260721T120000Z-ai-office'), true);
  assert.equal(KNOWLEDGE_REVIEW_ID_PATTERN.test('../knowledge-reviews'), false);
  assert.equal(KNOWLEDGE_REVIEW_ID_PATTERN.test('KLR-20260721T120000Z-ai-office/../../etc'), false);
});

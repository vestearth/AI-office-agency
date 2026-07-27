import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeReviewService, KNOWLEDGE_REVIEW_ID_PATTERN } from './knowledgeReviews';

const VALIDATOR_PATH = path.resolve(__dirname, '../../../../scripts/validate-knowledge-librarian.rb');

function service(reviewsDir: string, workspaceRoot?: string): KnowledgeReviewService {
  return new KnowledgeReviewService(reviewsDir, workspaceRoot, VALIDATOR_PATH);
}

async function countingService(reviewsDir: string): Promise<{
  reviews: KnowledgeReviewService;
  calls: () => Promise<string[]>;
}> {
  const validatorPath = path.join(reviewsDir, 'counting-validator.rb');
  const callsPath = path.join(reviewsDir, 'validator-calls.log');
  await fs.writeFile(validatorPath, `
require 'rbconfig'
File.open(${JSON.stringify(callsPath)}, 'a') { |file| file.puts(ARGV.last) }
exec(RbConfig.ruby, ${JSON.stringify(VALIDATOR_PATH)}, *ARGV)
`);
  return {
    reviews: new KnowledgeReviewService(reviewsDir, undefined, validatorPath),
    calls: async () => {
      try {
        const source = await fs.readFile(callsPath, 'utf8');
        return source.trim().split(/\r?\n/).filter(Boolean);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    },
  };
}

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

test('KnowledgeReviewService renders the normalized canonical validator output', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-review-normalized-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'review.yaml'), fixture('KLR-20260721T120000Z-ai-office', '2026-07-21T12:00:00Z'));

  const review = await service(dir).getById('KLR-20260721T120000Z-ai-office');
  assert.ok(review);
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
  await fs.writeFile(path.join(dir, 'newer.yaml'), fixture('KLR-20260721T120000Z-newer', '2026-07-21T12:00:00Z'));
  await fs.writeFile(path.join(dir, 'broken.yaml'), 'artifact_type: [');

  const reviews = service(dir);
  const result = await reviews.list();

  assert.equal(result.total, 2);
  assert.equal(result.invalidCount, 1);
  assert.deepEqual(result.invalidFiles, ['broken.yaml']);
  assert.equal(result.reviews[0].reviewId, 'KLR-20260721T120000Z-newer');
  assert.equal(result.reviews[0].appliedChangesCount, 0);
  assert.equal((await reviews.getById('KLR-20260720T120000Z-older'))?.summary, 'Reviewed one note.');
});

test('KnowledgeReviewService returns an empty model when the directory is absent', async () => {
  const reviews = service(path.join(os.tmpdir(), `missing-knowledge-reviews-${Date.now()}`));
  const result = await reviews.list();
  assert.equal(result.total, 0);
  assert.equal(result.invalidCount, 0);
});

test('KnowledgeReviewService coalesces loads and revalidates only changed audits', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-review-cache-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'review.yaml');
  const reviewId = 'KLR-20260721T120000Z-cache';
  await fs.writeFile(filePath, fixture(reviewId, '2026-07-21T12:00:00Z'));
  const { reviews, calls } = await countingService(dir);

  const [firstList, secondList, firstDetail] = await Promise.all([
    reviews.list(),
    reviews.list(),
    reviews.getById(reviewId),
  ]);
  assert.equal(firstList.total, 1);
  assert.equal(secondList.total, 1);
  assert.equal(firstDetail?.reviewId, reviewId);
  assert.equal((await calls()).length, 1);

  await reviews.list();
  await reviews.getById(reviewId);
  assert.equal((await calls()).length, 1);

  await fs.writeFile(
    filePath,
    fixture(reviewId, '2026-07-21T12:00:00Z').replace('Reviewed one note.', 'Reviewed one updated note.'),
  );
  assert.equal((await reviews.getById(reviewId))?.summary, 'Reviewed one updated note.');
  assert.equal((await calls()).length, 2);

  await fs.rm(filePath);
  assert.equal((await reviews.list()).total, 0);
  assert.equal((await calls()).length, 2);
});

test('KnowledgeReviewService quarantines every file that shares a review id', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-review-duplicates-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const duplicate = fixture('KLR-20260721T120000Z-duplicate', '2026-07-21T12:00:00Z');
  await fs.writeFile(path.join(dir, 'first.yaml'), duplicate);
  await fs.writeFile(path.join(dir, 'second.yaml'), duplicate);

  const reviews = service(dir);
  const result = await reviews.list();

  assert.equal(result.total, 0);
  assert.equal(result.invalidCount, 2);
  assert.deepEqual(result.invalidFiles, ['first.yaml', 'second.yaml']);
  assert.equal(await reviews.getById('KLR-20260721T120000Z-duplicate'), null);
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

  const result = await service(dir, root).list();

  assert.equal(result.total, 1);
  assert.equal(result.reviews[0].reviewId, 'KLR-20260721T120000Z-authorized');
  assert.deepEqual(result.invalidFiles, ['outside-policy.yaml', 'ruby-regex-mismatch.yaml']);
});

test('KnowledgeReviewService uses canonical contract and semantic validation for every audit', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-review-invalid-contract-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const invalid = new Map<string, string>([
    ['bounded-scope.yaml', fixture('KLR-20260721T120000Z-invalid-scope', '2026-07-21T12:00:00Z').replace('max_notes: 5', 'max_notes: 6')],
    ['write-mode.yaml', fixture('KLR-20260721T120001Z-invalid-write', '2026-07-21T12:00:01Z').replace('disposition: proposed', 'disposition: applied')],
    ['missing-field.yaml', fixture('KLR-20260721T120002Z-missing-field', '2026-07-21T12:00:02Z').replace('    closure_criteria: "Current repository evidence confirms the answer"\n', '')],
    ['unknown-fingerprint.yaml', fixture('KLR-20260721T120003Z-unknown-fingerprint', '2026-07-21T12:00:03Z').replace('finding_fingerprint: ai-office:test', 'finding_fingerprint: ai-office:missing')],
    ['impossible-day.yaml', fixture('KLR-20260721T120004Z-impossible-day', '2026-02-30T12:00:00Z')],
    ['impossible-hour.yaml', fixture('KLR-20260721T120005Z-impossible-hour', '2026-01-01T24:00:00Z')],
  ]);
  await Promise.all([...invalid].map(([name, source]) => fs.writeFile(path.join(dir, name), source)));

  const result = await service(dir).list();

  assert.equal(result.total, 0);
  assert.deepEqual(result.invalidFiles, [...invalid.keys()].sort());
});

test('KnowledgeReviewService surfaces canonical validator failures instead of quarantining all audits', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-review-validator-failure-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'review.yaml'), fixture('KLR-20260721T120000Z-valid', '2026-07-21T12:00:00Z'));

  const reviews = new KnowledgeReviewService(dir, undefined, path.join(dir, 'missing-validator.rb'));
  await assert.rejects(reviews.list());
});

test('knowledge review ids reject traversal-shaped input', () => {
  assert.equal(KNOWLEDGE_REVIEW_ID_PATTERN.test('KLR-20260721T120000Z-ai-office'), true);
  assert.equal(KNOWLEDGE_REVIEW_ID_PATTERN.test('../knowledge-reviews'), false);
  assert.equal(KNOWLEDGE_REVIEW_ID_PATTERN.test('KLR-20260721T120000Z-ai-office/../../etc'), false);
});

function fixtureWithPriorities(reviewId: string, generatedAt: string, priorities: string[]): string {
  const findings = priorities
    .map((priority, index) => `  - fingerprint: ai-office:test-${index}
    note_path: "Knowledge Base/10 Projects/AI Office Agency/Project Map.md"
    question: "Is item ${index} current?"
    issue_type: source_drift
    status: new
    priority: ${priority}
    evidence_state: confirmed
    verification_scope: source
    sources: ["ai-dev-office/README.md"]
    recommended_action: update_note
    closure_criteria: "Current repository evidence confirms the answer"
    answer: "Yes"
    opened_at: "2026-07-21T11:00:00Z"
    closed_at: null
    confidence: high
    proposed_patch: "Update the source reference"`)
    .join('\n');

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
write_mode: proposal_only
review_mode: pre_write
authorization: null
requires_human_review: true
notes_reviewed: ["Knowledge Base/10 Projects/AI Office Agency/Project Map.md"]
findings:
${findings || ' []'}
changes: []
summary: "Reviewed one note."
`;
}

test('list projection aggregates finding priorities without a second read', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-review-priority-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'mixed.yaml'),
    fixtureWithPriorities('KLR-20260721T120000Z-mixed', '2026-07-21T12:00:00Z', ['critical', 'high', 'high', 'low']),
  );
  await fs.writeFile(
    path.join(dir, 'empty.yaml'),
    fixtureWithPriorities('KLR-20260721T110000Z-empty', '2026-07-21T11:00:00Z', []),
  );

  const result = await service(dir).list();

  assert.equal(result.total, 2);
  assert.deepEqual(result.reviews[0].priorityCounts, { critical: 1, high: 2, low: 1 });
  assert.deepEqual(result.reviews[1].priorityCounts, {});
});

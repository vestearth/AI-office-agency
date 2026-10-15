import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { KnowledgeOpenFinding } from '@shared/types';
import { HumanDecisionStore, attachDecisions, classifyDecisionKind, latestDecisions, validateDecision } from './knowledgeDecisions';
import { buildRecheckBrief } from './knowledgeReviews';

test('classifyDecisionKind on questions from the 2026-10-15 decision queue', () => {
  const cases: [string, string][] = [
    ["Does the Money Path closeout's stale unstarted/blocked description of TASK-EAR-266 need a second proposal after the Phase A wait elapsed?", 'duplicate_proposal'],
    ['Should this audit create another proposal for the stale TASK-EAR-273 live-incident and D6 wording?', 'duplicate_proposal'],
    ["Should the existing proposal for Game's bet_amount/win_loss_amount settle dimensions be duplicated for this Player Log note?", 'duplicate_proposal'],
    ['Does EAR-341 require a new durable update beyond the existing proposal to describe Missions as a consumer?', 'duplicate_proposal'],
    ['Does EAR-341 require another Monitoring boundary correction after the previously verified committed Daily progress fields?', 'duplicate_proposal'],
    ['Should these staging-hardened fixes be promoted to production now?', 'approval'],
    ['Should ADR-0002 move from Proposed to Accepted during this closeout?', 'approval'],
    ['Is the tester roster sufficiently sourced and safe to retain as durable project knowledge?', 'approval'],
    ['Is the TASK-EAR-252 delivery status current while the credential exposure closure remains open?', 'status_check'],
    ['Does TASK-EAR-363 still accurately say the promotion is waiting for pushes and review?', 'status_check'],
    ['Has TASK-EAR-245 received browser proof for external E-Voucher Create at the local PR head?', 'status_check'],
    ['Does rerunning shared-lib make buf leave a clean working tree limited to the Weekly completion-bonus contract?', 'status_check'],
    ['Should Games-Labs-Logs own the cross-system business activity and audit projection while domain services retain authoritative records?', 'product'],
    ['How will VP configuration preserve legacy TH and new THA cohorts after the authorized source fix?', 'product'],
  ];
  for (const [q, kind] of cases) assert.equal(classifyDecisionKind(q), kind, q);
});

test('validateDecision: answer enum, actor required, note required for answer and no_longer_true', () => {
  assert.equal(validateDecision({ fingerprint: 'fp', answer: 'still_true', actor: 'earth' }).ok, true);
  assert.match((validateDecision({ fingerprint: 'fp', answer: 'maybe', actor: 'earth' }) as { error: string }).error, /answer must be one of/);
  assert.match((validateDecision({ fingerprint: 'fp', answer: 'approve', actor: '  ' }) as { error: string }).error, /actor is required/);
  assert.match((validateDecision({ fingerprint: 'fp', answer: 'answer', actor: 'earth', note: ' ' }) as { error: string }).error, /note is required/);
  assert.match((validateDecision({ fingerprint: 'fp', answer: 'no_longer_true', actor: 'earth' }) as { error: string }).error, /note is required/);
  const ok = validateDecision({ fingerprint: ' fp ', answer: 'answer', actor: ' earth ', note: ' Logs owns it ' });
  assert.deepEqual(ok, { ok: true, value: { fingerprint: 'fp', answer: 'answer', note: 'Logs owns it', actor: 'earth' } });
});

test('HumanDecisionStore appends with sequential ids under decisions/, and the latest answer wins', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kdec-'));
  const store = new HumanDecisionStore(dir);
  assert.deepEqual(await store.read(), []);
  await Promise.all([
    store.append({ fingerprint: 'a', answer: 'defer', actor: 'earth', question: 'q?', notePath: 'n.md' }, new Date('2026-10-15T01:00:00Z')),
    store.append({ fingerprint: 'b', answer: 'approve', actor: 'earth', question: 'q?', notePath: 'n.md' }, new Date('2026-10-15T02:00:00Z')),
  ]);
  await store.append({ fingerprint: 'a', answer: 'answer', note: 'yes', actor: 'earth', question: 'q?', notePath: 'n.md' }, new Date('2026-10-15T03:00:00Z'));
  const all = await store.read();
  assert.deepEqual(all.map((d) => d.id), ['hd-001', 'hd-002', 'hd-003']);
  assert.equal(store.file, path.join(dir, 'decisions', 'human-decisions.yaml'));
  // Nothing written directly under the reviews dir, where every *.yaml is read as an audit.
  assert.deepEqual((await fs.readdir(dir)).sort(), ['decisions']);
  const latest = latestDecisions(all);
  assert.equal(latest.get('a')!.answer, 'answer');
  assert.equal(latest.get('a')!.note, 'yes');
  await fs.rm(dir, { recursive: true, force: true });
});

const finding = (over: Partial<KnowledgeOpenFinding> = {}): KnowledgeOpenFinding => ({
  fingerprint: 'fp-1', notePath: 'Knowledge Base/Review Queue.md', folder: 'Knowledge Base', question: 'Should ADR-0002 move from Proposed to Accepted?',
  priority: 'low', status: 'recurring', evidenceState: 'confirmed', recommendedAction: 'no_change', needsHumanDecision: true,
  timesReported: 1, firstReportedAt: '2026-10-01T00:00:00Z', lastReportedAt: '2026-10-10T00:00:00Z', reviewId: 'KLR-1', closureCriteria: 'Human decides',
  ...over,
});

test('attachDecisions: pending only when answered after the latest audit and not deferred', () => {
  const d = (answer: 'approve' | 'defer', decidedAt: string) => ({ id: 'hd-001', fingerprint: 'fp-1', answer, actor: 'earth', decidedAt, question: '', notePath: '' });
  const [fresh] = attachDecisions([finding()], new Map([['fp-1', d('approve', '2026-10-15T00:00:00Z')]]));
  assert.equal(fresh!.decisionKind, 'approval');
  assert.equal(fresh!.decisionPending, true);
  const [seen] = attachDecisions([finding({ lastReportedAt: '2026-10-16T00:00:00Z' })], new Map([['fp-1', d('approve', '2026-10-15T00:00:00Z')]]));
  assert.equal(seen!.decisionPending, false);
  const [deferred] = attachDecisions([finding()], new Map([['fp-1', d('defer', '2026-10-15T00:00:00Z')]]));
  assert.equal(deferred!.decisionPending, false);
  const [machine] = attachDecisions([finding({ needsHumanDecision: false })], new Map());
  assert.equal(machine!.decisionKind, undefined);
});

test('task brief lists pending operator answers with what to do, outside the note caps and scope', () => {
  const answered = attachDecisions([
    finding({ fingerprint: 'fp-1' }),
    finding({ fingerprint: 'fp-2', notePath: 'Knowledge Base/30 ADR/ADR-0006.md' }),
  ], new Map([
    ['fp-1', { id: 'hd-001', fingerprint: 'fp-1', answer: 'approve' as const, actor: 'earth', decidedAt: '2026-10-15T01:00:00Z', question: '', notePath: '' }],
    ['fp-2', { id: 'hd-002', fingerprint: 'fp-2', answer: 'defer' as const, actor: 'earth', decidedAt: '2026-10-15T02:00:00Z', question: '', notePath: '' }],
  ]));
  const brief = buildRecheckBrief(answered, 2, { audience: 'task', scopePatterns: [/^nothing-matches$/], now: new Date('2026-10-17T11:00:00Z') });
  assert.equal(brief.notes.length, 0, 'human-decision findings never enter the note list');
  assert.deepEqual(brief.answers.map((a) => [a.decisionId, a.answer]), [['hd-001', 'approve']]);
  assert.match(brief.text, /Operator answers to record \(1;/);
  assert.match(brief.text, /fp-1 — hd-001 by earth on 2026-10-15: approve/);
  assert.match(brief.text, /Do: record the operator's approval/);
  // Human briefs never carry answers.
  assert.deepEqual(buildRecheckBrief(answered, 2, { audience: 'human' }).answers, []);
});

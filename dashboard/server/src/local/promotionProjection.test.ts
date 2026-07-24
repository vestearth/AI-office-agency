import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectIntakeForPromotion, assertNoForbiddenFields, PROMOTION_PROJECTION_VERSION } from './promotionProjection';

const intake = {
  id: 'INTAKE-1', title: 'Wallet debit fails', body: 'repro steps', product_hint: 'wallet',
  tester_id: 'TSTR-secret', // must NOT leak
};
const triage = { schemaVersion: 'triage.v1', classification: 'triaged', summary: 'debit path bug', riskFlags: ['money'], duplicateCandidates: ['INTAKE-0'], contextHash: 'h' };

test('projection includes allowed fields and excludes identity/secrets', () => {
  const p = projectIntakeForPromotion({ intake: intake as any, triage: triage as any });
  assert.equal(p.projectionVersion, PROMOTION_PROJECTION_VERSION);
  assert.equal(p.centralIntakeId, 'INTAKE-1');
  assert.equal(p.title, 'Wallet debit fails');
  assert.equal(p.triageSummary, 'debit path bug');
  assert.deepEqual(p.riskFlags, ['money']);
  // forbidden identity fields absent
  assert.equal((p as any).tester_id, undefined);
  assert.equal((p as any).testerRealName, undefined);
  assertNoForbiddenFields(p); // does not throw
});

test('assertNoForbiddenFields throws if a forbidden key sneaks in', () => {
  assert.throws(() => assertNoForbiddenFields({ ...({} as any), accessCode: 'x' }));
});

test('projection handles null triage', () => {
  const p = projectIntakeForPromotion({ intake: intake as any, triage: null });
  assert.equal(p.triageSummary, null);
  assert.deepEqual(p.riskFlags, []);
  assert.deepEqual(p.duplicateRefs, []);
  assertNoForbiddenFields(p);
});

test('projection reporterRef is pseudonymous and stable per intake, never the tester id', () => {
  const p1 = projectIntakeForPromotion({ intake: intake as any, triage: null });
  const p2 = projectIntakeForPromotion({ intake: intake as any, triage: null });
  assert.equal(p1.reporterRef, p2.reporterRef);
  assert.equal(p1.reporterRef.includes('TSTR-secret'), false);
});

test('promo.v2 carries the structured fields and no identity leaks', () => {
  const intake: any = { id: 'INTAKE-1', title: 'B', body: 'd', product_hint: 'wallet', tester_id: 'TSTR-x',
    severity: 'high', repro_steps: 'r', expected: 'e', actual: 'a', environment: 'env' };
  const p = projectIntakeForPromotion({ intake, triage: { summary: 's' } as any });
  assert.equal(p.projectionVersion, 'promo.v2');
  assert.equal(p.severity, 'high');
  assert.equal(p.reproSteps, 'r');
  assert.equal((p as any).tester_id, undefined);
  assertNoForbiddenFields(p);
});

test('promo.v2 fields are undefined when intake lacks them (except reproSteps, which falls back to body)', () => {
  const p = projectIntakeForPromotion({ intake: intake as any, triage: null });
  assert.equal(p.severity, undefined);
  assert.equal(p.expected, undefined);
  assert.equal(p.actual, undefined);
  assert.equal(p.environment, undefined);
  // no structured repro_steps on this fixture -> falls back to full body
  assert.equal(p.reproSteps, intake.body);
  assertNoForbiddenFields(p);
});

test('reproSteps falls back to the full untruncated body when repro_steps is unset (no information loss vs promo.v1)', () => {
  const longBody = 'x'.repeat(2500) + 'TAIL-MARKER-END';
  const bigIntake: any = { id: 'INTAKE-2', title: 'Big bug', body: longBody, product_hint: 'wallet', tester_id: 'TSTR-y' };
  const p = projectIntakeForPromotion({ intake: bigIntake, triage: null });
  // summary is truncated at 2000 chars (pre-existing, unchanged behavior)
  assert.equal(p.summary.length, 2000);
  assert.equal(p.summary.includes('TAIL-MARKER-END'), false);
  // reproSteps carries the FULL body, including the tail beyond 2000 chars
  assert.equal(p.reproSteps, longBody);
  assert.ok(p.reproSteps!.includes('TAIL-MARKER-END'));
  assertNoForbiddenFields(p);
});

test('reproSteps uses the structured repro_steps field, not the body, when both are present', () => {
  const bigIntake: any = {
    id: 'INTAKE-3', title: 'Bug', body: 'x'.repeat(3000) + 'BODY-TAIL', product_hint: 'wallet', tester_id: 'TSTR-z',
    repro_steps: '1. open  2. click',
  };
  const p = projectIntakeForPromotion({ intake: bigIntake, triage: null });
  assert.equal(p.reproSteps, '1. open  2. click');
  assert.equal(p.reproSteps!.includes('BODY-TAIL'), false);
});

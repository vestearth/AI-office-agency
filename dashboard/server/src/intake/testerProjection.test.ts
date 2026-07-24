import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toTesterIntake, displayStatusFor } from './testerProjection';

const row: any = {
  id: 'INTAKE-1', tester_id: 'TSTR-secret', title: 'Bug', body: 'desc', product_hint: 'wallet',
  state: 'ai_failed', revision: 3, change_seq: 9, idempotency_key: 'k',
  severity: 'high', repro_steps: 'r', expected: 'e', actual: 'a', environment: 'env',
  created_at: 1700, updated_at: 1800,
};

test('projection exposes only allowed keys and maps status server-side', () => {
  const p = toTesterIntake(row);
  assert.deepEqual(Object.keys(p).sort(), ['actual','body','createdAt','displayStatus','environment','expected','id','productHint','reproSteps','severity','title'].sort());
  assert.equal((p as any).tester_id, undefined);
  assert.equal((p as any).state, undefined);
  assert.equal((p as any).revision, undefined);
  assert.equal((p as any).idempotency_key, undefined);
  assert.equal(p.displayStatus, 'In review'); // ai_failed is hidden as "In review"
});

test('displayStatusFor is exhaustive and fail-closed', () => {
  assert.equal(displayStatusFor('submitted'), 'Submitted');
  assert.equal(displayStatusFor('triaged'), 'In review');
  assert.equal(displayStatusFor('decided'), 'In review');
  assert.equal(displayStatusFor('needs_scope_review'), 'In review');
  assert.equal(displayStatusFor('ai_failed'), 'In review');
  assert.equal(displayStatusFor('promoted'), 'Accepted — being worked on');
  assert.equal(displayStatusFor('closed'), 'Closed');
  assert.equal(displayStatusFor('some_future_state'), 'In review'); // fail-closed
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnForState, groupIntoColumns, gateOpen } from './columns';

test('states map to the four working columns; closed/decided are not shown', () => {
  assert.equal(columnForState('submitted'), 'inbox');
  assert.equal(columnForState('needs_scope_review'), 'attention');
  assert.equal(columnForState('ai_failed'), 'attention');
  assert.equal(columnForState('triaged'), 'ready');
  assert.equal(columnForState('promoted'), 'promoted');
  assert.equal(columnForState('closed'), null);
  assert.equal(columnForState('decided'), null);
});

test('groupIntocolumns buckets summaries and drops non-column states', () => {
  const g = groupIntoColumns([
    { state: 'submitted' } as any, { state: 'triaged' } as any,
    { state: 'closed' } as any, { state: 'ai_failed' } as any,
  ]);
  assert.equal(g.inbox.length, 1);
  assert.equal(g.ready.length, 1);
  assert.equal(g.attention.length, 1);
  assert.equal(g.promoted.length, 0);
});

test('gateOpen requires a triaged latestTriage', () => {
  assert.equal(gateOpen({ latestTriage: { schemaVersion: 'triage.v1', classification: 'triaged' } } as any), true);
  assert.equal(gateOpen({ latestTriage: { classification: 'ai_failed' } } as any), false);
  assert.equal(gateOpen({ latestTriage: null } as any), false);
});

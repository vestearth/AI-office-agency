import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTriageResult, TRIAGE_SCHEMA_VERSION } from './triageSchema';

const good = {
  schemaVersion: TRIAGE_SCHEMA_VERSION, classification: 'triaged',
  summary: 'Looks like a wallet debit bug', contextHash: 'abc123',
};

test('valid triage result passes and strips unknown fields', () => {
  const r = validateTriageResult({ ...good, sneakySecret: 'AKIA...', sourceSnippet: 'code' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal((r.value as any).sneakySecret, undefined); // stripped
    assert.equal((r.value as any).sourceSnippet, undefined);
    assert.equal(r.value.classification, 'triaged');
  }
});

test('wrong schema version and bad classification are rejected', () => {
  assert.equal(validateTriageResult({ ...good, schemaVersion: 'triage.v0' }).ok, false);
  assert.equal(validateTriageResult({ ...good, classification: 'promoted' }).ok, false);
  assert.equal(validateTriageResult({ summary: 'x' }).ok, false); // missing required
});

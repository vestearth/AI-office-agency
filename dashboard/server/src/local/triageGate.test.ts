import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPromotionGate } from './triageGate';
import { TRIAGE_SCHEMA_VERSION } from '../intake/triageSchema';

const triaged = { schemaVersion: TRIAGE_SCHEMA_VERSION, classification: 'triaged', summary: 's', contextHash: 'h' };

test('valid triaged result opens the gate without override', () => {
  const r = checkPromotionGate({ intakeState: 'triaged', latestTriage: triaged });
  assert.deepEqual(r, { allowed: true, reason: 'triage_valid', gateOverridden: false });
});

test('missing/failed triage blocks unless a reasoned override is given', () => {
  assert.equal(checkPromotionGate({ intakeState: 'submitted', latestTriage: null }).allowed, false);
  assert.equal(checkPromotionGate({ intakeState: 'ai_failed', latestTriage: { ...triaged, classification: 'ai_failed' } }).allowed, false);
  // reason-less override does NOT open the gate
  assert.equal(checkPromotionGate({ intakeState: 'ai_failed', latestTriage: null, override: { reason: '' } }).allowed, false);
  // reasoned override opens it and flags gateOverridden
  const o = checkPromotionGate({ intakeState: 'ai_failed', latestTriage: null, override: { reason: 'urgent hotfix' } });
  assert.deepEqual(o, { allowed: true, reason: 'gate_overridden', gateOverridden: true });
});

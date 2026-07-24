import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTriagePackage } from './triagePackage';
import { TRIAGE_SCHEMA_VERSION } from '../intake/triageSchema';

const intake = { id: 'INTAKE-1', title: 'Wallet debit fails', body: 'steps', product_hint: 'wallet', state: 'submitted', revision: 1 };
const provenance = [{ repo: '/r/w', branch: 'main', sha: 'deadbeef', dirty: false, capturedAt: 1, machine: 'm1' }];

test('package embeds intake+provenance+schema version and a stable contextHash', () => {
  const pkg = buildTriagePackage({ intake: intake as any, repos: ['Games-Labs-Wallet'], provenance, approvedSnippets: [] });
  assert.equal(pkg.promptSchemaVersion, TRIAGE_SCHEMA_VERSION);
  assert.equal(pkg.manifest.intake.title, 'Wallet debit fails');
  assert.deepEqual(pkg.manifest.provenance, provenance);
  assert.ok(pkg.contextHash.length >= 16);
  // Deterministic: same inputs -> same hash
  const again = buildTriagePackage({ intake: intake as any, repos: ['Games-Labs-Wallet'], provenance, approvedSnippets: [] });
  assert.equal(again.contextHash, pkg.contextHash);
});

test('no raw attachment bytes are ever included', () => {
  const pkg = buildTriagePackage({ intake: intake as any, repos: ['Games-Labs-Wallet'], provenance, approvedSnippets: [] });
  assert.equal(JSON.stringify(pkg.manifest).includes('base64'), false);
  assert.equal((pkg.manifest as any).attachments, undefined);
});

test('throws when repos is empty (needs_scope_review must block package build)', () => {
  assert.throws(() => {
    buildTriagePackage({ intake: intake as any, repos: [], provenance, approvedSnippets: [] });
  }, /needs_scope_review/);
});

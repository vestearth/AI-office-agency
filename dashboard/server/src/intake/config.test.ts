import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { loadIntakeConfig, parseRepoAllowlist } from './config';

test('loadIntakeConfig derives dbPath under dataDir and applies caps', () => {
  const cfg = loadIntakeConfig({
    INTAKE_DATA_DIR: '/tmp/intake-data',
    INTAKE_ATTACHMENT_DIR: '',
    INTAKE_ATTACHMENT_MAX_BYTES: '5242880',
  });
  assert.equal(cfg.dbPath, path.join('/tmp/intake-data', 'intake.sqlite'));
  // Attachment dir defaults under dataDir when unset.
  assert.equal(cfg.attachmentDir, path.join('/tmp/intake-data', 'attachments'));
  assert.equal(cfg.attachment.maxBytes, 5_242_880);
  assert.ok(cfg.attachment.allowedMime.includes('image/png'));
  assert.ok(!cfg.attachment.allowedMime.includes('application/zip'));
});

test('parseRepoAllowlist returns [] for empty/undefined input', () => {
  assert.deepEqual(parseRepoAllowlist(undefined), []);
  assert.deepEqual(parseRepoAllowlist(''), []);
  assert.deepEqual(parseRepoAllowlist('   '), []);
});

test('parseRepoAllowlist returns [] for invalid JSON without throwing', () => {
  assert.doesNotThrow(() => parseRepoAllowlist('not json'));
  assert.deepEqual(parseRepoAllowlist('not json'), []);
});

test('parseRepoAllowlist returns [] when parsed JSON is not an array', () => {
  assert.deepEqual(parseRepoAllowlist('{"name":"x"}'), []);
});

test('parseRepoAllowlist filters out entries missing path', () => {
  assert.deepEqual(parseRepoAllowlist('[{"name":"Games-Labs-Wallet"}]'), []);
});

test('parseRepoAllowlist filters out entries missing name but keeps valid ones', () => {
  const result = parseRepoAllowlist(
    '[{"path":"/repos/no-name"},{"name":"Games-Labs-Wallet","path":"/repos/wallet"}]'
  );
  assert.deepEqual(result, [{ name: 'Games-Labs-Wallet', path: '/repos/wallet' }]);
});

test('parseRepoAllowlist returns a fully valid array as-is', () => {
  const input = '[{"name":"Games-Labs-Wallet","path":"/repos/wallet"}]';
  assert.deepEqual(parseRepoAllowlist(input), [{ name: 'Games-Labs-Wallet', path: '/repos/wallet' }]);
});

test('loadIntakeConfig never throws and defaults allowlist to [] on malformed JSON', () => {
  assert.doesNotThrow(() => loadIntakeConfig({ INTAKE_REPO_ALLOWLIST: 'not json' }));
  const cfg = loadIntakeConfig({ INTAKE_REPO_ALLOWLIST: 'not json' });
  assert.deepEqual(cfg.intakeRepoAllowlist, []);
});

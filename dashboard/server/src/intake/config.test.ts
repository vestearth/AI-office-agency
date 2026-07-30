import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { loadIntakeConfig, parseRepoAllowlist, parseProductList } from './config';

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

test('parseProductList validates and fails closed', () => {
  assert.deepEqual(parseProductList(undefined), []);
  assert.deepEqual(parseProductList('not json'), []);
  assert.deepEqual(parseProductList('{"value":"x"}'), []); // not an array
  assert.deepEqual(parseProductList('[{"value":"wallet"}]'), []); // missing label
  assert.deepEqual(
    parseProductList('[{"value":"wallet","label":"Wallet"},{"bad":1}]'),
    [{ value: 'wallet', label: 'Wallet' }]
  );
});

test('parseProductList returns a fully valid array as-is', () => {
  const input = '[{"value":"Games-Labs-Wallet","label":"Wallet"},{"value":"Games-Labs-Missions","label":"Missions"}]';
  assert.deepEqual(parseProductList(input), [
    { value: 'Games-Labs-Wallet', label: 'Wallet' },
    { value: 'Games-Labs-Missions', label: 'Missions' },
  ]);
});

test('loadIntakeConfig defaults intakeProductList to [] and wires parseProductList', () => {
  const cfg = loadIntakeConfig({ INTAKE_PRODUCT_LIST: undefined });
  assert.deepEqual(cfg.intakeProductList, []);
  const cfg2 = loadIntakeConfig({ INTAKE_PRODUCT_LIST: '[{"value":"wallet","label":"Wallet"}]' });
  assert.deepEqual(cfg2.intakeProductList, [{ value: 'wallet', label: 'Wallet' }]);
});

test('cookieSecure defaults ON and only the exact string "false" turns it off', () => {
  // Default: no env var at all -> Secure stays on (the M1 hardening default).
  assert.equal(loadIntakeConfig({}).cookieSecure, true);
  // Deliberate plain-HTTP LAN opt-out.
  assert.equal(loadIntakeConfig({ INTAKE_COOKIE_SECURE: 'false' }).cookieSecure, false);
  assert.equal(loadIntakeConfig({ INTAKE_COOKIE_SECURE: ' FALSE ' }).cookieSecure, false);
  // Fail-safe: typos / empty / anything else must NOT downgrade the cookie.
  for (const v of ['', ' ', 'no', '0', 'off', 'fals', 'true']) {
    assert.equal(loadIntakeConfig({ INTAKE_COOKIE_SECURE: v }).cookieSecure, true, `env value ${JSON.stringify(v)} must keep Secure on`);
  }
});

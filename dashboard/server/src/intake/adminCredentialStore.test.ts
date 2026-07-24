import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { provisionAdminCredential, verifyAdminSecret, revokeAdminCredential } from './adminCredentialStore';

test('provisioned secret verifies with its capabilities; raw secret is never stored', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const { id, secret } = provisionAdminCredential(db, { label: 'local-machine', capabilities: ['intake:read', 'intake:promote'] });
  const stored = db.prepare('SELECT cred_hash FROM admin_credential WHERE id = ?').get(id) as any;
  assert.notEqual(stored.cred_hash, secret);
  const v = verifyAdminSecret(db, secret);
  assert.deepEqual(v, { ok: true, id, capabilities: ['intake:read', 'intake:promote'] });
});

test('an explicit secret round-trips instead of a random one', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const { id, secret } = provisionAdminCredential(db, { label: 'test', capabilities: ['intake:admin'], secret: 'known' });
  assert.equal(secret, 'known');
  assert.deepEqual(verifyAdminSecret(db, 'known'), { ok: true, id, capabilities: ['intake:admin'] });
});

test('wrong and revoked secrets do not verify', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const { id, secret } = provisionAdminCredential(db, { label: 'x', capabilities: ['intake:admin'] });
  assert.deepEqual(verifyAdminSecret(db, 'nope'), { ok: false });
  revokeAdminCredential(db, id);
  assert.deepEqual(verifyAdminSecret(db, secret), { ok: false });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { issueAccessCode, verifyAccessCode, revokeAccessCode } from './accessCodeStore';

test('issued code verifies to its tester and raw code is never stored', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  const { testerId, code } = issueAccessCode(db, 'QA Tester A');
  const stored = db.prepare('SELECT code_hash FROM access_code').get() as any;
  assert.notEqual(stored.code_hash, code); // stored as hash, not raw
  const res = verifyAccessCode(db, code);
  assert.deepEqual(res, { ok: true, testerId });
});

test('wrong and revoked codes do not verify', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  const { testerId, code } = issueAccessCode(db, 'QA Tester B');
  assert.deepEqual(verifyAccessCode(db, 'not-a-code'), { ok: false });
  revokeAccessCode(db, testerId);
  assert.deepEqual(verifyAccessCode(db, code), { ok: false });
});

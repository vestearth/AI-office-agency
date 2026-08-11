import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { issueAccessCode, verifyAccessCode, revokeAccessCode, rotateAccessCode, listTesterCodes } from './accessCodeStore';
import { createSession, getValidSession } from './sessionStore';

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

test('rotation preserves the tester while replacing codes and revoking existing sessions', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  const { testerId, code: oldCode } = issueAccessCode(db, 'QA Tester Rotate');
  const session = createSession(db, testerId, 1, 10_000);

  const rotated = rotateAccessCode(db, testerId, 2);
  assert.equal(rotated.ok, true);
  if (!rotated.ok) return;

  assert.deepEqual(verifyAccessCode(db, oldCode), { ok: false });
  assert.deepEqual(verifyAccessCode(db, rotated.code), { ok: true, testerId });
  assert.equal(getValidSession(db, session.sessionId, 3), null);
  assert.deepEqual(
    db.prepare('SELECT id, label, revoked_at FROM tester WHERE id = ?').get(testerId),
    { id: testerId, label: 'QA Tester Rotate', revoked_at: null },
  );
  assert.equal(listTesterCodes(db)[0].activeCodes, 1);
});

test('listTesterCodes summarizes testers with active-code counts and revocation', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  const a = issueAccessCode(db, 'QA Tester A');
  const b = issueAccessCode(db, 'QA Tester B');

  const before = listTesterCodes(db);
  assert.equal(before.length, 2);
  const rowA = before.find((r) => r.testerId === a.testerId)!;
  const rowB = before.find((r) => r.testerId === b.testerId)!;
  assert.equal(rowA.label, 'QA Tester A');
  assert.equal(rowA.activeCodes, 1);
  assert.equal(rowA.revoked, false);
  assert.equal(typeof rowA.createdAt, 'number');
  assert.equal(rowB.activeCodes, 1);

  revokeAccessCode(db, a.testerId);
  const after = listTesterCodes(db);
  const revokedA = after.find((r) => r.testerId === a.testerId)!;
  assert.equal(revokedA.revoked, true);
  assert.equal(revokedA.activeCodes, 0); // code revoked alongside the tester
  assert.equal(after.find((r) => r.testerId === b.testerId)!.activeCodes, 1);
});

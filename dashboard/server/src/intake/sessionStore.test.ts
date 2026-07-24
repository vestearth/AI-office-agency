import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { createSession, getValidSession, revokeSession } from './sessionStore';

test('created session validates until expiry, then not', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO tester(id,label,created_at) VALUES('t1','T',1)").run();
  const now = 1000;
  const s = createSession(db, 't1', now, 500); // ttl 500ms
  const ok = getValidSession(db, s.sessionId, now + 100);
  assert.equal(ok?.testerId, 't1');
  assert.equal(getValidSession(db, s.sessionId, now + 600), null); // expired
});

test('revoked session no longer validates', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO tester(id,label,created_at) VALUES('t1','T',1)").run();
  const s = createSession(db, 't1', 0, 10_000);
  revokeSession(db, s.sessionId);
  assert.equal(getValidSession(db, s.sessionId, 1), null);
});

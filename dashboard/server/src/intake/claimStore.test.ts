import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { submitIntake } from './intakeStore';
import { claimIntake, renewClaim, releaseClaim, getActiveClaim } from './claimStore';

function seed(db: any) {
  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)').run('t1', 'T', 1);
  return submitIntake(db, { testerId: 't1', title: 'A', body: 'x' }).intake;
}

test('first claim succeeds; second concurrent claim is rejected until expiry', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const intake = seed(db);
  const now = 1000;
  const a = claimIntake(db, { intakeId: intake.id, owner: 'earth', expectedRevision: intake.revision, now, ttlMs: 500 });
  assert.equal(a.ok, true);
  const b = claimIntake(db, { intakeId: intake.id, owner: 'bob', expectedRevision: intake.revision, now: now + 100, ttlMs: 500 });
  assert.deepEqual(b, { ok: false, reason: 'already_claimed' });
  // After TTL, the intake becomes claimable again (abandoned work).
  const c = claimIntake(db, { intakeId: intake.id, owner: 'bob', expectedRevision: intake.revision, now: now + 600, ttlMs: 500 });
  assert.equal(c.ok, true);
});

test('revision mismatch is a conflict, not a claim', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const intake = seed(db);
  const r = claimIntake(db, { intakeId: intake.id, owner: 'earth', expectedRevision: intake.revision + 5, now: 1, ttlMs: 500 });
  assert.deepEqual(r, { ok: false, reason: 'revision_conflict' });
});

test('renew/release are owner-scoped', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const intake = seed(db);
  const a: any = claimIntake(db, { intakeId: intake.id, owner: 'earth', expectedRevision: intake.revision, now: 1, ttlMs: 500 });
  assert.equal(renewClaim(db, { claimId: a.claim.id, owner: 'bob', now: 2, ttlMs: 500 }).ok, false);
  assert.equal(renewClaim(db, { claimId: a.claim.id, owner: 'earth', now: 2, ttlMs: 500 }).ok, true);
  releaseClaim(db, { claimId: a.claim.id, owner: 'earth' });
  assert.equal(getActiveClaim(db, intake.id, 3), null);
});

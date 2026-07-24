import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { submitIntake } from './intakeStore';
import { claimIntake } from './claimStore';
import { listReviewIntakes, getReviewDetail } from './reviewStore';

function seed(db: ReturnType<typeof openDb>) {
  const t = db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)');
  t.run('TSTR-1', 'QA A', 1);
  return submitIntake(db, { testerId: 'TSTR-1', title: 'Login crash', body: 'crashes',
    severity: 'high', reproSteps: 'rotate', expected: 'stays', actual: 'white', environment: 'iOS' }).intake;
}

test('listReviewIntakes returns summaries with counts and active-claim badge', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const intake = seed(db);
  const now = 1000;
  const before = listReviewIntakes(db, {}, now);
  assert.equal(before.intakes.length, 1);
  assert.equal(before.intakes[0].state, 'submitted');
  assert.equal(before.intakes[0].severity, 'high');
  assert.equal(before.intakes[0].claim, undefined);
  assert.equal(before.counts.submitted, 1);

  claimIntake(db, { intakeId: intake.id, owner: 'earth', expectedRevision: intake.revision, now, ttlMs: 60_000 });
  const after = listReviewIntakes(db, {}, now + 1);
  assert.equal(after.intakes[0].claim?.owner, 'earth');
  assert.equal(after.intakes[0].claim?.expiresAt, now + 60_000);
});

test('listReviewIntakes filters by state and hides closed unless asked', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const intake = seed(db);
  db.prepare('UPDATE intake SET state = ? WHERE id = ?').run('closed', intake.id);
  assert.equal(listReviewIntakes(db, {}, 1).intakes.length, 0);            // closed hidden
  assert.equal(listReviewIntakes(db, { includeClosed: true }, 1).intakes.length, 1);
  assert.equal(listReviewIntakes(db, { state: 'submitted' }, 1).intakes.length, 0);
});

test('getReviewDetail returns the full owner-facing intake with no extra columns', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const intake = seed(db);
  const detail = getReviewDetail(db, intake.id, 1)!;
  assert.equal(detail.reproSteps, 'rotate');
  assert.equal(detail.environment, 'iOS');
  assert.deepEqual(
    Object.keys(detail).sort(),
    ['activeClaim','actual','attachments','body','createdAt','environment','expected','hasTriage','id','latestTriage','productHint','reproSteps','revision','severity','state','title','updatedAt'].sort()
  );
  assert.equal(getReviewDetail(db, 'nope', 1), null);
});

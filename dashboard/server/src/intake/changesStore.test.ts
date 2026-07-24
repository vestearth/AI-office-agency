import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { submitIntake } from './intakeStore';
import { listChangesSince } from './changesStore';

function seedTester(db: any, id = 't1') {
  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)').run(id, 'T', 1);
}

test('changes feed returns intakes after a cursor in change_seq order', () => {
  const db = openDb(':memory:'); runMigrations(db); seedTester(db);
  const a = submitIntake(db, { testerId: 't1', title: 'A', body: 'x' }).intake;
  const b = submitIntake(db, { testerId: 't1', title: 'B', body: 'y' }).intake;

  const first = listChangesSince(db, 0, 100);
  assert.equal(first.changes.length, 2);
  assert.ok(first.changes[0].changeSeq < first.changes[1].changeSeq);
  assert.equal(first.nextCursor, first.changes[1].changeSeq);

  // Only newer-than-cursor rows come back on the next pull.
  const afterFirst = listChangesSince(db, first.changes[0].changeSeq, 100);
  assert.equal(afterFirst.changes.length, 1);
  assert.equal(afterFirst.changes[0].intakeId, b.id);
});

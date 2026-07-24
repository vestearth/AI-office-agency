import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { submitIntake, getIntake } from './intakeStore';
import { recordPromotion, getPromotion } from './promotionRecordStore';

function seed(db: any) {
  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)').run('t1', 'T', 1);
  return submitIntake(db, { testerId: 't1', title: 'A', body: 'x' }).intake;
}

test('first record creates the relationship and marks the intake promoted; second is idempotent', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const intake = seed(db);
  const a = recordPromotion(db, { intakeId: intake.id, taskId: 'TASK-EAR-007', projectionVersion: 'promo.v1', gateOverridden: false });
  assert.deepEqual(a, { created: true, taskId: 'TASK-EAR-007' });
  assert.equal(getIntake(db, intake.id)!.state, 'promoted');

  // A second promote for the same intake returns the ORIGINAL task id, no new row.
  const b = recordPromotion(db, { intakeId: intake.id, taskId: 'TASK-EAR-999', projectionVersion: 'promo.v1', gateOverridden: false });
  assert.deepEqual(b, { created: false, taskId: 'TASK-EAR-007' });
  assert.equal((db.prepare('SELECT COUNT(*) c FROM promotion').get() as any).c, 1);
  assert.equal(getPromotion(db, intake.id)!.task_id, 'TASK-EAR-007');
});

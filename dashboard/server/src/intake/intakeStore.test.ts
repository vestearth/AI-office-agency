import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { submitIntake, listIntakes, getIntake } from './intakeStore';

function seedTester(db: any) {
  db.prepare("INSERT INTO tester(id,label,created_at) VALUES('t1','T',1)").run();
}

test('submit creates a submitted intake and it is listable/gettable', () => {
  const db = openDb(':memory:'); runMigrations(db); seedTester(db);
  const { intake, deduped } = submitIntake(db, { testerId: 't1', title: 'Crash', body: 'steps' });
  assert.equal(deduped, false);
  assert.equal(intake.state, 'submitted');
  assert.equal(listIntakes(db, { testerId: 't1' }).length, 1);
  assert.equal(getIntake(db, intake.id)?.title, 'Crash');
});

test('same idempotency key for a tester dedupes instead of duplicating', () => {
  const db = openDb(':memory:'); runMigrations(db); seedTester(db);
  const a = submitIntake(db, { testerId: 't1', title: 'X', body: 'y', idempotencyKey: 'k1' });
  const b = submitIntake(db, { testerId: 't1', title: 'X', body: 'y', idempotencyKey: 'k1' });
  assert.equal(b.deduped, true);
  assert.equal(a.intake.id, b.intake.id);
  assert.equal(listIntakes(db, { testerId: 't1' }).length, 1);
});

test('rejects over-long title', () => {
  const db = openDb(':memory:'); runMigrations(db); seedTester(db);
  assert.throws(() => submitIntake(db, { testerId: 't1', title: 'x'.repeat(201), body: 'y' }));
});

test('submitIntake stores structured fields and severity enum is validated', () => {
  const db = openDb(':memory:'); runMigrations(db); seedTester(db);
  const { intake } = submitIntake(db, {
    testerId: 't1', title: 'Crash', body: 'desc',
    severity: 'high', reproSteps: '1. open 2. click', expected: 'ok', actual: 'boom', environment: 'iOS 18',
  });
  const row = getIntake(db, intake.id)!;
  assert.equal(row.severity, 'high');
  assert.equal(row.repro_steps, '1. open 2. click');
  assert.equal(row.expected, 'ok');
  assert.equal(row.actual, 'boom');
  assert.equal(row.environment, 'iOS 18');
  assert.throws(() => submitIntake(db, { testerId: 't1', title: 'x', body: 'y', severity: 'urgent' as any }));
});

test('structured fields are optional (backward-compat)', () => {
  const db = openDb(':memory:'); runMigrations(db); seedTester(db);
  const { intake } = submitIntake(db, { testerId: 't1', title: 'x', body: 'y' });
  const row = getIntake(db, intake.id)!;
  assert.equal(row.severity, null);
  assert.equal(row.repro_steps, null);
});

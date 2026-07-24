import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { submitIntake, getIntake } from './intakeStore';
import { importTriageResult } from './triageStore';
import { TRIAGE_SCHEMA_VERSION } from './triageSchema';

function seed(db: any) {
  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)').run('t1', 'T', 1);
  return submitIntake(db, { testerId: 't1', title: 'A', body: 'x' }).intake;
}
const result = { schemaVersion: TRIAGE_SCHEMA_VERSION, classification: 'triaged', summary: 's', contextHash: 'h' };

test('valid import transitions intake state to the classification and stores the row', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const intake = seed(db);
  const r = importTriageResult(db, { intakeId: intake.id, expectedRevision: intake.revision, raw: result, importer: 'earth' });
  assert.equal(r.ok, true);
  assert.equal(getIntake(db, intake.id)!.state, 'triaged');
  assert.equal((db.prepare('SELECT COUNT(*) c FROM triage_result').get() as any).c, 1);
});

test('schema-invalid import is rejected and does not change intake state', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const intake = seed(db);
  const r = importTriageResult(db, { intakeId: intake.id, expectedRevision: intake.revision, raw: { bad: true }, importer: 'earth' });
  assert.equal(r.ok, false);
  assert.equal(getIntake(db, intake.id)!.state, 'submitted'); // unchanged
});

test('revision conflict is rejected', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const intake = seed(db);
  const r = importTriageResult(db, { intakeId: intake.id, expectedRevision: intake.revision + 3, raw: result, importer: 'earth' });
  assert.equal(r.ok, false);
});

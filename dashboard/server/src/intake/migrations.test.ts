import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';

test('runMigrations is idempotent and creates core tables', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  runMigrations(db); // second run must not throw (boot replays all migrations)
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r: any) => r.name);
  for (const t of ['access_code', 'attachment', 'audit_event', 'intake', 'session', 'tester']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  const ver = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as any;
  assert.ok(ver.v >= 1);
});

test('intake enforces unique idempotency_key per tester', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO tester(id,label,created_at) VALUES('t1','T',1)").run();
  const ins = db.prepare(
    "INSERT INTO intake(id,tester_id,title,body,state,revision,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)"
  );
  ins.run('i1', 't1', 'a', 'b', 'submitted', 1, 'key-1', 1, 1);
  assert.throws(() => ins.run('i2', 't1', 'a', 'b', 'submitted', 1, 'key-1', 1, 1));
});

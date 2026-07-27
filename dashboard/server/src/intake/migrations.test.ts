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

test('runMigrations repairs guarded columns when schema_version is ahead of the table', () => {
  const db = openDb(':memory:');
  db.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    INSERT INTO schema_version(version, applied_at) VALUES (1, 1), (2, 1), (3, 1), (4, 1), (5, 1);
    CREATE TABLE intake (
      id TEXT PRIMARY KEY, tester_id TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, product_hint TEXT,
      state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      idempotency_key TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      change_seq INTEGER NOT NULL DEFAULT 0
    );
  `);

  runMigrations(db);

  const columns = new Set(
    (db.prepare('PRAGMA table_info(intake)').all() as { name: string }[]).map((column) => column.name)
  );
  for (const column of ['severity', 'repro_steps', 'expected', 'actual', 'environment']) {
    assert.ok(columns.has(column), `missing repaired column ${column}`);
  }
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

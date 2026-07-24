import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { usedStorageBytes, overHighWater } from './storage';

function setup() {
  const db = openDb(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO tester(id,label,created_at) VALUES('t1','T',1)").run();
  db.prepare(
    "INSERT INTO intake(id,tester_id,title,body,state,revision,created_at,updated_at) VALUES('i1','t1','a','b','submitted',1,1,1)"
  ).run();
  return db;
}

function insertAttachment(db: any, id: string, byteSize: number, deletedAt: number | null) {
  db.prepare(
    `INSERT INTO attachment(id,intake_id,stored_name,original_name,mime,byte_size,content_hash,created_at,deleted_at)
     VALUES(?, 'i1', ?, ?, 'image/png', ?, 'hash', 1, ?)`
  ).run(id, `${id}.png`, `${id}.png`, byteSize, deletedAt);
}

test('usedStorageBytes sums only non-deleted rows', () => {
  const db = setup();
  insertAttachment(db, 'a1', 1000, null);
  insertAttachment(db, 'a2', 2000, null);
  insertAttachment(db, 'a3', 5000, Date.now()); // soft-deleted, excluded
  assert.equal(usedStorageBytes(db), 3000);
});

test('usedStorageBytes returns 0 when there are no attachments', () => {
  const db = setup();
  assert.equal(usedStorageBytes(db), 0);
});

test('overHighWater is false below the threshold and true at/above it', () => {
  const db = setup();
  insertAttachment(db, 'a1', 500, null);
  assert.equal(overHighWater(db, 1000), false);
  insertAttachment(db, 'a2', 500, null);
  assert.equal(overHighWater(db, 1000), true); // exactly at threshold
  insertAttachment(db, 'a3', 1, null);
  assert.equal(overHighWater(db, 1000), true); // above threshold
});

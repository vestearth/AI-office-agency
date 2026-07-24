import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { makeAttachmentStore } from './attachmentStore';

// 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-att-'));
  const db = openDb(':memory:'); runMigrations(db);
  db.prepare("INSERT INTO tester(id,label,created_at) VALUES('t1','T',1)").run();
  db.prepare("INSERT INTO intake(id,tester_id,title,body,state,revision,created_at,updated_at) VALUES('i1','t1','a','b','submitted',1,1,1)").run();
  const store = makeAttachmentStore({
    attachmentDir: dir,
    caps: { maxBytes: 5_242_880, maxPerIntake: 2, maxAggregateBytesPerIntake: 10_000_000, allowedMime: ['image/png'] },
  });
  return { db, dir, store };
}

test('stores a valid PNG and writes the file to disk', async () => {
  const { db, dir, store } = setup();
  const row = await store.storeAttachment(db, { intakeId: 'i1', originalName: 'shot.png', buffer: PNG });
  assert.equal(row.mime, 'image/png');
  assert.ok(fs.existsSync(path.join(dir, row.stored_name)));
});

test('rejects a fake-extension file whose bytes are not an allowed type', async () => {
  const { db, store } = setup();
  const fake = Buffer.from('MZ\x90\x00 this is actually an exe');
  await assert.rejects(
    () => store.storeAttachment(db, { intakeId: 'i1', originalName: 'evil.png', buffer: fake }),
    /BAD_TYPE/
  );
});

test('enforces per-intake attachment count cap', async () => {
  const { db, store } = setup();
  await store.storeAttachment(db, { intakeId: 'i1', originalName: 'a.png', buffer: PNG });
  await store.storeAttachment(db, { intakeId: 'i1', originalName: 'b.png', buffer: PNG });
  await assert.rejects(
    () => store.storeAttachment(db, { intakeId: 'i1', originalName: 'c.png', buffer: PNG }),
    /TOO_MANY/
  );
});

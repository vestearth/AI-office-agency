import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { makeAttachmentStore } from './attachmentStore';
import { runRetention } from './retention';

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-retention-'));
  const db = openDb(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO tester(id,label,created_at) VALUES('t1','T',1)").run();
  return { db, dir };
}

function insertIntake(db: ReturnType<typeof openDb>, id: string, state: string, updatedAt: number) {
  db.prepare(
    `INSERT INTO intake(id,tester_id,title,body,state,revision,created_at,updated_at)
     VALUES(?,'t1','title','body',?,1,?,?)`
  ).run(id, state, updatedAt, updatedAt);
}

async function insertAttachment(
  db: ReturnType<typeof openDb>,
  dir: string,
  intakeId: string,
  attId: string
): Promise<void> {
  const store = makeAttachmentStore({
    attachmentDir: dir,
    caps: { maxBytes: 5_242_880, maxPerIntake: 10, maxAggregateBytesPerIntake: 10_000_000, allowedMime: ['text/plain'] },
  });
  const row = await store.storeAttachment(db, {
    intakeId,
    originalName: `${attId}.txt`,
    buffer: Buffer.from('hello'),
  });
  // Overwrite the generated id with our deterministic test id for easy lookup.
  db.prepare('UPDATE attachment SET id = ? WHERE id = ?').run(attId, row.id);
}

test('deletes attachments on closed/promoted intakes closed 90+ days ago, keeps recent ones', async () => {
  const { db, dir } = setup();
  const now = Date.now();

  insertIntake(db, 'i-old', 'promoted', now - 100 * DAY);
  await insertAttachment(db, dir, 'i-old', 'att-old');

  insertIntake(db, 'i-recent', 'promoted', now - 10 * DAY);
  await insertAttachment(db, dir, 'i-recent', 'att-recent');

  const oldRowBefore = db.prepare('SELECT stored_name FROM attachment WHERE id = ?').get('att-old') as any;
  const oldFilePath = path.join(dir, oldRowBefore.stored_name);
  assert.ok(fs.existsSync(oldFilePath));

  const result = await runRetention(db, { now, attachmentDir: dir });

  assert.equal(result.attachmentsDeleted, 1);
  assert.equal(result.errors.length, 0);

  const oldRow = db.prepare('SELECT deleted_at FROM attachment WHERE id = ?').get('att-old') as any;
  assert.ok(oldRow.deleted_at, 'old attachment should be soft-deleted');
  assert.ok(!fs.existsSync(oldFilePath), 'old attachment file should be unlinked');

  const recentRow = db.prepare('SELECT deleted_at FROM attachment WHERE id = ?').get('att-recent') as any;
  assert.equal(recentRow.deleted_at, null, 'recent attachment should be kept');
});

test('deletes sessions 7+ days past expiry, keeps ones within grace', async () => {
  const { db, dir } = setup();
  const now = Date.now();

  db.prepare(
    "INSERT INTO session(id,tester_id,csrf_token,created_at,expires_at) VALUES('s-old','t1','csrf1',1,?)"
  ).run(now - 8 * DAY);
  db.prepare(
    "INSERT INTO session(id,tester_id,csrf_token,created_at,expires_at) VALUES('s-recent','t1','csrf2',1,?)"
  ).run(now - 5 * DAY);

  const result = await runRetention(db, { now, attachmentDir: dir });

  assert.equal(result.sessionsDeleted, 1);

  const oldSession = db.prepare('SELECT * FROM session WHERE id = ?').get('s-old');
  assert.equal(oldSession, undefined, 'old session should be hard-deleted');

  const recentSession = db.prepare('SELECT * FROM session WHERE id = ?').get('s-recent');
  assert.ok(recentSession, 'recent session should be kept');
});

test('leaves structured data (intake, audit_event) untouched even when very old', async () => {
  const { db, dir } = setup();
  const now = Date.now();

  // 200 days old but not in a terminal state that would trigger attachment
  // sweeping logic misapplication to the intake row itself — this asserts
  // the sweep never deletes the intake or audit_event rows regardless of age.
  insertIntake(db, 'i-veryold', 'closed', now - 200 * DAY);
  db.prepare(
    "INSERT INTO audit_event(id,kind,actor_kind,intake_id,created_at) VALUES('aud-old','submitted','tester','i-veryold',?)"
  ).run(now - 200 * DAY);

  await runRetention(db, { now, attachmentDir: dir });

  const intakeRow = db.prepare('SELECT * FROM intake WHERE id = ?').get('i-veryold');
  assert.ok(intakeRow, 'structured intake row must be retained regardless of age');

  const auditRow = db.prepare('SELECT * FROM audit_event WHERE id = ?').get('aud-old');
  assert.ok(auditRow, 'structured audit_event row must be retained regardless of age');
});

test('happy path returns an empty errors array and does not throw', async () => {
  const { db, dir } = setup();
  const now = Date.now();
  const result = await runRetention(db, { now, attachmentDir: dir });
  assert.deepEqual(result.errors, []);
  assert.equal(typeof result.attachmentsDeleted, 'number');
  assert.equal(typeof result.sessionsDeleted, 'number');
});

test('supports policy overrides for attachmentClosedMs and sessionGraceMs', async () => {
  const { db, dir } = setup();
  const now = Date.now();

  insertIntake(db, 'i-5d', 'closed', now - 5 * DAY);
  await insertAttachment(db, dir, 'i-5d', 'att-5d');

  db.prepare(
    "INSERT INTO session(id,tester_id,csrf_token,created_at,expires_at) VALUES('s-2d','t1','csrf3',1,?)"
  ).run(now - 2 * DAY);

  const result = await runRetention(db, {
    now,
    attachmentDir: dir,
    policy: { attachmentClosedMs: 1 * DAY, sessionGraceMs: 1 * DAY },
  });

  assert.equal(result.attachmentsDeleted, 1);
  assert.equal(result.sessionsDeleted, 1);
});

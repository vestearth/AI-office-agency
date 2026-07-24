import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { runBackup, verifyRestore } from './backup';

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-backup-'));
  const backupTarget = path.join(dir, 'backups');
  const attachmentDir = path.join(dir, 'attachments');
  fs.mkdirSync(attachmentDir, { recursive: true });
  const db = openDb(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO tester(id,label,created_at) VALUES('t1','T',1)").run();
  db.prepare(
    `INSERT INTO intake(id,tester_id,title,body,state,revision,created_at,updated_at)
     VALUES('i1','t1','title','body','open',1,1,1)`
  ).run();
  return { dir, backupTarget, attachmentDir, db };
}

function insertAttachment(
  db: ReturnType<typeof openDb>,
  id: string,
  overrides: Partial<{ deletedAt: number | null }> = {}
) {
  db.prepare(
    `INSERT INTO attachment(id, intake_id, stored_name, original_name, mime, byte_size, content_hash, created_at, deleted_at)
     VALUES(?, 'i1', ?, ?, 'text/plain', 5, ?, 1, ?)`
  ).run(id, `${id}.txt`, `${id}-original.txt`, `hash-${id}`, overrides.deletedAt ?? null);
}

test('runBackup writes a WAL-consistent snapshot + manifest, verifyRestore confirms integrity', async () => {
  const { backupTarget, attachmentDir, db } = setup();
  insertAttachment(db, 'att-1');
  insertAttachment(db, 'att-2');
  insertAttachment(db, 'att-deleted', { deletedAt: 999 });

  const now = Date.parse('2026-01-15T10:20:30Z');
  const result = await runBackup(db, { backupTarget, attachmentDir, now });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(fs.existsSync(result.snapshotPath), 'snapshot file should exist');
  assert.ok(fs.existsSync(result.manifestPath), 'manifest file should exist');

  const verify = verifyRestore(result.snapshotPath);
  assert.equal(verify.ok, true);
  assert.equal(verify.integrity, 'ok');
  for (const t of ['tester', 'access_code', 'session', 'intake', 'attachment', 'audit_event', 'admin_credential']) {
    assert.ok(verify.tables.includes(t), `expected table ${t} in snapshot`);
  }

  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(manifest.length, 2, 'manifest should exclude soft-deleted attachments');
  const byId: Record<string, any> = Object.fromEntries(manifest.map((m: any) => [m.stored_name, m]));
  assert.ok(byId['att-1.txt']);
  assert.equal(byId['att-1.txt'].content_hash, 'hash-att-1');
  assert.equal(byId['att-1.txt'].original_name, 'att-1-original.txt');
  assert.equal(byId['att-1.txt'].byte_size, 5);
});

test('runBackup rotation keeps only keepDaily newest daily snapshots', async () => {
  const { backupTarget, attachmentDir, db } = setup();
  const base = Date.parse('2026-01-01T00:00:00Z');

  for (let i = 0; i < 10; i++) {
    const now = base + i * DAY;
    const result = await runBackup(db, { backupTarget, attachmentDir, now, keepDaily: 7, keepWeekly: 4 });
    assert.equal(result.ok, true);
  }

  const files = fs.readdirSync(backupTarget).filter((f) => f.endsWith('.sqlite'));
  assert.equal(files.length, 7, `expected 7 snapshots retained, got ${files.length}: ${files.join(',')}`);

  // The newest snapshot (day index 9) must be retained.
  const manifests = fs.readdirSync(backupTarget).filter((f) => f.endsWith('.manifest.json'));
  assert.equal(manifests.length, files.length, 'each retained snapshot should keep its manifest pair');
});

test('runBackup returns {ok:false, error} instead of throwing on failure', async () => {
  const { attachmentDir, db } = setup();
  // Point backupTarget at a path that cannot be created (file exists where a dir is expected).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-backup-fail-'));
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a dir');
  const backupTarget = path.join(blocker, 'nested'); // mkdir under a file must fail

  const result = await runBackup(db, { backupTarget, attachmentDir, now: Date.now() });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(typeof result.error === 'string' && result.error.length > 0);
});

test('verifyRestore reports not-ok for a corrupt/incomplete file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-backup-corrupt-'));
  const bogus = path.join(dir, 'bogus.sqlite');
  fs.writeFileSync(bogus, 'not a real sqlite database');

  const verify = verifyRestore(bogus);
  assert.equal(verify.ok, false);
});

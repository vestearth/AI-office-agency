import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../intake/db';
import { runMigrations } from '../intake/migrations';
import { submitIntake } from '../intake/intakeStore';
import { makeInProcessReviewBackend } from './reviewBackend';

function setup() {
  const db = openDb(':memory:'); runMigrations(db);
  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)').run('TSTR-1', 'QA', 1);
  const intake = submitIntake(db, { testerId: 'TSTR-1', title: 'Coin wrong', body: 'balance off' }).intake;
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-'));
  const be = makeInProcessReviewBackend(db, {
    runsDir, officeRoot: '/tmp', now: () => 1000,
    validate: async () => ({ ok: true }),
  });
  return { db, intake, be, runsDir };
}

test('claim rejects a stale revision with revision_conflict', async () => {
  const { intake, be, runsDir } = setup();
  try {
    const bad = await be.claim(intake.id, intake.revision + 5);
    assert.equal(bad.ok, false);
    assert.equal((bad as any).reason, 'revision_conflict');
    const good = await be.claim(intake.id, intake.revision);
    assert.equal(good.ok, true);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test('recordTriage rejects an invalid payload and accepts a valid triaged result', async () => {
  const { db, intake, be, runsDir } = setup();
  try {
    const bad = await be.recordTriage(intake.id, intake.revision, { schemaVersion: 'nope' });
    assert.equal(bad.ok, false);
    const ok = await be.recordTriage(intake.id, intake.revision,
      { schemaVersion: 'triage.v1', classification: 'triaged', summary: 's', contextHash: 'h' });
    assert.equal(ok.ok, true);
    assert.equal((db.prepare('SELECT state FROM intake WHERE id=?').get(intake.id) as any).state, 'triaged');
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test('promote is blocked without triage and writes a TASK dir once triaged', async () => {
  const { intake, be, runsDir } = setup();
  try {
    const blocked = await be.promote(intake.id, intake.revision, { prefix: 'EAR' });
    assert.equal(blocked.ok, false); // gate_blocked (no triage, no override)

    await be.recordTriage(intake.id, intake.revision,
      { schemaVersion: 'triage.v1', classification: 'triaged', summary: 's', contextHash: 'h' });
    const fresh = (await be.detail(intake.id))!;
    const promoted = await be.promote(intake.id, fresh.revision, { prefix: 'EAR' });
    assert.equal(promoted.ok, true);
    assert.match((promoted as any).taskId, /^TASK-EAR-\d+$/);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test('promote rejects an empty/whitespace prefix and writes no run dir', async () => {
  const { intake, be, runsDir } = setup();
  try {
    await be.recordTriage(intake.id, intake.revision,
      { schemaVersion: 'triage.v1', classification: 'triaged', summary: 's', contextHash: 'h' });
    const fresh = (await be.detail(intake.id))!;

    const empty = await be.promote(intake.id, fresh.revision, { prefix: '' });
    assert.equal(empty.ok, false);
    assert.equal((empty as any).reason, 'invalid_prefix');

    const whitespace = await be.promote(intake.id, fresh.revision, { prefix: '   ' });
    assert.equal(whitespace.ok, false);
    assert.equal((whitespace as any).reason, 'invalid_prefix');

    assert.deepEqual(fs.readdirSync(runsDir), []);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

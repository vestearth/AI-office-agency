import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import fs from 'node:fs';
import { openDb } from '../../intake/db';
import { runMigrations } from '../../intake/migrations';
import { submitIntake } from '../../intake/intakeStore';
import { buildReviewRouter } from './review';
import { makeInProcessReviewBackend } from '../../local/reviewBackend';

function app(db: any, runsDir: string) {
  const a = express();
  a.use('/api/intake/review', buildReviewRouter(makeInProcessReviewBackend(db, {
    runsDir, officeRoot: os.tmpdir(), now: () => 1000, validate: async () => ({ ok: true }),
  })));
  return a;
}

async function call(app: any, method: string, path: string, opts: any = {}) {
  const { createServer } = await import('http');
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: opts.headers, body: opts.body });
  const text = await res.text();
  server.close();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('round trip: list → claim → triage → promote through the real routes', async () => {
  const db = openDb(':memory:'); runMigrations(db);
  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)').run('TSTR-1', 'QA', 1);
  const intake = submitIntake(db, { testerId: 'TSTR-1', title: 'X', body: 'y', severity: 'high' }).intake;
  const runsDir = fs.mkdtempSync(os.tmpdir() + '/rev-');
  const a = app(db, runsDir);
  try {
    const list = await call(a, 'GET', '/api/intake/review/intakes');
    assert.equal(list.status, 200);
    assert.equal(list.body.intakes[0].severity, 'high'); // full field crosses the boundary

    const claim = await call(a, 'POST', `/api/intake/review/intakes/${intake.id}/claim`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: intake.revision }),
    });
    assert.equal(claim.status, 200);

    const triage = await call(a, 'POST', `/api/intake/review/intakes/${intake.id}/triage-result`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: intake.revision,
        result: { schemaVersion: 'triage.v1', classification: 'triaged', summary: 's', contextHash: 'h' },
      }),
    });
    assert.equal(triage.status, 200);

    const fresh = await call(a, 'GET', `/api/intake/review/intakes/${intake.id}`);
    const promote = await call(a, 'POST', `/api/intake/review/intakes/${intake.id}/promote`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: fresh.body.revision, prefix: 'EAR' }),
    });
    assert.equal(promote.status, 201);
    assert.match(promote.body.taskId, /^TASK-EAR-\d+$/);
    assert.equal(fs.existsSync(runsDir + '/' + promote.body.taskId + '/task.md'), true);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test('stale revision on claim returns 409 revision_conflict', async () => {
  const db = openDb(':memory:'); runMigrations(db);
  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)').run('TSTR-1', 'QA', 1);
  const intake = submitIntake(db, { testerId: 'TSTR-1', title: 'X', body: 'y' }).intake;
  const runsDir = fs.mkdtempSync(os.tmpdir() + '/rev-');
  const a = app(db, runsDir);
  try {
    const r = await call(a, 'POST', `/api/intake/review/intakes/${intake.id}/claim`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: intake.revision + 9 }),
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, 'revision_conflict');
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test('triage-package on an ambiguous product hint returns needsScopeReview (empty allowlist guard)', async () => {
  const db = openDb(':memory:'); runMigrations(db);
  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)').run('TSTR-1', 'QA', 1);
  const intake = submitIntake(db, { testerId: 'TSTR-1', title: 'X', body: 'y', productHint: 'some-unmatched-repo' }).intake;
  const runsDir = fs.mkdtempSync(os.tmpdir() + '/rev-');
  const a = app(db, runsDir);
  try {
    const r = await call(a, 'POST', `/api/intake/review/intakes/${intake.id}/triage-package`);
    assert.equal(r.status, 200);
    assert.equal(r.body.needsScopeReview, true);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

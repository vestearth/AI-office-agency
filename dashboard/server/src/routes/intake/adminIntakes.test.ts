import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../../intake/db';
import { runMigrations } from '../../intake/migrations';
import { submitIntake } from '../../intake/intakeStore';
import { provisionAdminCredential } from '../../intake/adminCredentialStore';
import { createSession } from '../../intake/sessionStore';
import { buildAdminIntakesRouter } from './adminIntakes';

async function call(app: any, path: string, headers: any = {}) {
  const { createServer } = await import('http');
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  const body = await res.json().catch(() => ({}));
  server.close();
  return { status: res.status, body };
}

function setup() {
  const db = openDb(':memory:');
  runMigrations(db);
  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)').run('t1', 'T', 1);
  const { intake } = submitIntake(db, { testerId: 't1', title: 'A', body: 'x' });
  provisionAdminCredential(db, { label: 'test', secret: 'admin-secret', capabilities: ['intake:read'] });
  const app = express();
  app.use('/api/intake/admin/intakes', buildAdminIntakesRouter(db));
  return { db, app, intake };
}

test('no bearer -> 401', async () => {
  const { app, intake } = setup();
  const res = await call(app, `/api/intake/admin/intakes/${intake.id}`);
  assert.equal(res.status, 401);
});

test('valid admin bearer with intake:read -> 200 full row', async () => {
  const { app, intake } = setup();
  const res = await call(app, `/api/intake/admin/intakes/${intake.id}`, { authorization: 'Bearer admin-secret' });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, intake.id);
  assert.equal(res.body.tester_id, 't1');
  assert.equal(res.body.state, 'submitted');
});

test('unknown id -> 404', async () => {
  const { app } = setup();
  const res = await call(app, `/api/intake/admin/intakes/NOPE`, { authorization: 'Bearer admin-secret' });
  assert.equal(res.status, 404);
});

test('a valid tester session cookie (no admin bearer) is rejected — not session-guarded', async () => {
  const { db, app, intake } = setup();
  const session = createSession(db, 't1', Date.now());
  const res = await call(app, `/api/intake/admin/intakes/${intake.id}`, {
    cookie: `intake_sid=${session.sessionId}`,
  });
  assert.equal(res.status, 401);
});

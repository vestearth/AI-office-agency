import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../../intake/db';
import { runMigrations } from '../../intake/migrations';
import { submitIntake } from '../../intake/intakeStore';
import { provisionAdminCredential } from '../../intake/adminCredentialStore';
import { buildChangesRouter } from './changes';

async function call(app: any, path: string, headers: any = {}) {
  const { createServer } = await import('http');
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  const body = await res.json();
  server.close();
  return { status: res.status, body };
}

test('changes route requires admin token and returns deltas', async () => {
  const db = openDb(':memory:'); runMigrations(db);
  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)').run('t1', 'T', 1);
  submitIntake(db, { testerId: 't1', title: 'A', body: 'x' });
  // Real hashed admin-credential guard (M3): provision a known secret so the
  // existing `Bearer admin-secret` requests below keep verifying.
  provisionAdminCredential(db, { label: 'test', secret: 'admin-secret', capabilities: ['intake:read'] });
  const app = express();
  app.use('/api/intake/changes', buildChangesRouter(db, 'admin-secret'));

  const noAuth = await call(app, '/api/intake/changes?since=0');
  assert.equal(noAuth.status, 401);

  const ok = await call(app, '/api/intake/changes?since=0', { authorization: 'Bearer admin-secret' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.changes.length, 1);
  assert.ok(ok.body.nextCursor > 0);
});

test('changes route is guarded by the real makeAdminAuth, not the old shared-token shim', async () => {
  // A db WITH a provisioned credential: no Authorization header at all must
  // 401 (not merely reject the wrong token) — proves the real guard reads
  // admin_credential rather than comparing against `adminToken` directly.
  const dbWithCred = openDb(':memory:'); runMigrations(dbWithCred);
  provisionAdminCredential(dbWithCred, { label: 'test', secret: 'admin-secret', capabilities: ['intake:read'] });
  const appWithCred = express();
  appWithCred.use('/api/intake/changes', buildChangesRouter(dbWithCred, 'admin-secret'));
  const noHeader = await call(appWithCred, '/api/intake/changes?since=0');
  assert.equal(noHeader.status, 401);

  // A db with NO credential provisioned at all must fail closed with 503,
  // never pass the request through open.
  const dbNoCred = openDb(':memory:'); runMigrations(dbNoCred);
  const appNoCred = express();
  appNoCred.use('/api/intake/changes', buildChangesRouter(dbNoCred, 'admin-secret'));
  const unprovisioned = await call(appNoCred, '/api/intake/changes?since=0', { authorization: 'Bearer admin-secret' });
  assert.equal(unprovisioned.status, 503);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { openDb } from '../../intake/db';
import { runMigrations } from '../../intake/migrations';
import { submitIntake } from '../../intake/intakeStore';
import { provisionAdminCredential } from '../../intake/adminCredentialStore';
import { mountIntakeRoutes } from '../intake';
import { makeCentralClient } from '../../local/centralClient';
import { mountLocalRoutes } from './index';

async function listen(app: any) {
  const { createServer } = await import('http');
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  return { server, port: (server.address() as any).port };
}

test('Local refresh pulls Central changes and advances the cursor', async () => {
  const db = openDb(':memory:'); runMigrations(db);
  // Real hashed admin-credential guard (M3): shared by both the Central mount
  // and the Local mount below (both point at this same in-memory db), so one
  // provision covers the `Bearer admin-secret` requests on both sides.
  provisionAdminCredential(db, {
    label: 'test', secret: 'admin-secret',
    capabilities: ['intake:read', 'intake:claim', 'intake:triage', 'intake:promote', 'intake:admin'],
  });
  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)').run('t1', 'T', 1);
  submitIntake(db, { testerId: 't1', title: 'A', body: 'x' });

  const central = express();
  mountIntakeRoutes(central, { db, allowedOrigins: ['https://intake.lan'], adminToken: 'admin-secret' });
  const { server, port } = await listen(central);

  const client = makeCentralClient({ baseUrl: `http://127.0.0.1:${port}`, adminToken: 'admin-secret' });
  const cursorPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-')), 'cursor.json');
  const local = express();
  mountLocalRoutes(local, 'admin-secret', { db, client, cursorPath, runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'r-')), taskPrefix: 'EAR', validate: async () => ({ ok: true }), now: () => 1 });
  const { server: ls, port: lport } = await listen(local);

  const res = await fetch(`http://127.0.0.1:${lport}/api/local/refresh`, { method: 'POST', headers: { authorization: 'Bearer admin-secret' } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.changes.length, 1);
  assert.ok(body.cursor > 0);
  assert.equal(JSON.parse(fs.readFileSync(cursorPath, 'utf8')).seq, body.cursor);
  server.close(); ls.close();
});

test('Local promote reaches Central only via the injected client and is idempotent end-to-end', async () => {
  const db = openDb(':memory:'); runMigrations(db);
  provisionAdminCredential(db, {
    label: 'test', secret: 'admin-secret',
    capabilities: ['intake:read', 'intake:claim', 'intake:triage', 'intake:promote', 'intake:admin'],
  });
  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)').run('t1', 'T', 1);
  const { intake } = submitIntake(db, { testerId: 't1', title: 'A', body: 'x' });

  const central = express();
  mountIntakeRoutes(central, { db, allowedOrigins: ['https://intake.lan'], adminToken: 'admin-secret' });
  const { server, port } = await listen(central);

  const client = makeCentralClient({ baseUrl: `http://127.0.0.1:${port}`, adminToken: 'admin-secret' });
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r-'));
  const local = express();
  mountLocalRoutes(local, 'admin-secret', {
    db, client, cursorPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-')), 'cursor.json'),
    runsDir, taskPrefix: 'EAR', validate: async () => ({ ok: true }), now: () => 1,
  });
  const { server: ls, port: lport } = await listen(local);

  const promoteBody = {
    intake: {
      id: intake.id, title: intake.title, body: intake.body,
      product_hint: null, tester_id: 't1', revision: intake.revision, state: intake.state,
    },
    triage: null,
    override: { reason: 'manual admin override for M2 wiring smoke test' },
    owner: 'owner1',
  };

  const res1 = await fetch(`http://127.0.0.1:${lport}/api/local/intakes/${intake.id}/promote`, {
    method: 'POST', headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
    body: JSON.stringify(promoteBody),
  });
  const body1 = await res1.json();
  assert.equal(res1.status, 201);
  assert.ok(body1.ok);
  assert.match(body1.taskId, /^TASK-EAR-\d{3}$/);

  // Central recorded the relationship via the client (never direct SQLite
  // access from Local) and transitioned the intake to `promoted`.
  const { getPromotion } = await import('../../intake/promotionRecordStore');
  const promo = getPromotion(db, intake.id);
  assert.ok(promo);
  assert.equal(promo!.task_id, body1.taskId);

  // A second promote attempt for the same intake must not mint a second TASK
  // dir nor overwrite the recorded relationship.
  const res2 = await fetch(`http://127.0.0.1:${lport}/api/local/intakes/${intake.id}/promote`, {
    method: 'POST', headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
    body: JSON.stringify(promoteBody),
  });
  const body2 = await res2.json();
  assert.equal(res2.status, 201);
  assert.equal(getPromotion(db, intake.id)!.task_id, body1.taskId);
  // The retried promote must converge on the ORIGINAL taskId, not mint a
  // second one — promoteIntake rolls back the run dir it just allocated once
  // it learns (via central.recordPromotion's {created:false,...} result)
  // that the intake was already promoted.
  assert.equal(body2.taskId, body1.taskId);
  const taskDirs = fs.readdirSync(runsDir).filter((e) => e.startsWith('TASK-'));
  assert.equal(taskDirs.length, 1); // no orphan run dir left behind
  assert.deepEqual(taskDirs, [body1.taskId]);

  server.close(); ls.close();
});

test('Local route returns 502 (not a process crash) when the Central client throws', async () => {
  const db = openDb(':memory:'); runMigrations(db);
  provisionAdminCredential(db, { label: 'test', secret: 'admin-secret', capabilities: ['intake:admin'] });
  const throwingClient = {
    getChanges: async () => { throw new Error('central unreachable'); },
    claim: async () => { throw new Error('unused'); },
    renewClaim: async () => { throw new Error('unused'); },
    releaseClaim: async () => { throw new Error('unused'); },
    importTriage: async () => { throw new Error('unused'); },
    recordPromotion: async () => { throw new Error('unused'); },
  };

  const local = express();
  mountLocalRoutes(local, 'admin-secret', {
    db, client: throwingClient as any,
    cursorPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-')), 'cursor.json'),
    runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'r-')), taskPrefix: 'EAR',
    validate: async () => ({ ok: true }), now: () => 1,
  });
  const { server: ls, port: lport } = await listen(local);

  const res = await fetch(`http://127.0.0.1:${lport}/api/local/refresh`, {
    method: 'POST', headers: { authorization: 'Bearer admin-secret' },
  });
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.error, 'central_unavailable');
  assert.match(body.detail, /central unreachable/);

  ls.close();
});

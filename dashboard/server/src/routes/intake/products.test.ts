import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../../intake/db';
import { runMigrations } from '../../intake/migrations';
import { issueAccessCode } from '../../intake/accessCodeStore';
import { provisionAdminCredential } from '../../intake/adminCredentialStore';
import { mountIntakeRoutes } from './index';

function makeApp() {
  const db = openDb(':memory:'); runMigrations(db);
  provisionAdminCredential(db, {
    label: 'test', secret: 'admin-secret',
    capabilities: ['intake:read', 'intake:claim', 'intake:triage', 'intake:promote', 'intake:admin'],
  });
  const app = express();
  mountIntakeRoutes(app, { db, allowedOrigins: ['https://intake.lan'], adminToken: 'admin-secret' });
  return { app, db };
}

async function call(app: any, method: string, path: string, opts: any = {}) {
  const { createServer } = await import('http');
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: opts.headers, body: opts.body,
  });
  const text = await res.text();
  server.close();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null,
    cookie: res.headers.get('set-cookie') };
}

test('GET /api/intake/products requires a tester session and returns the list', async () => {
  const { app, db } = makeApp();

  const noSession = await call(app, 'GET', '/api/intake/products');
  assert.equal(noSession.status, 401);

  const { code } = issueAccessCode(db, 'QA A');
  const login = await call(app, 'POST', '/api/intake/session', {
    headers: { 'content-type': 'application/json', origin: 'https://intake.lan' },
    body: JSON.stringify({ code }),
  });
  assert.equal(login.status, 200);
  const sid = /intake_sid=([^;]+)/.exec(login.cookie || '')![1];

  const ok = await call(app, 'GET', '/api/intake/products', {
    headers: { cookie: `intake_sid=${sid}` },
  });
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.body.products));
});

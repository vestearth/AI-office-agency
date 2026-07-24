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
  // Real hashed admin-credential guard (M3): provision a known secret so the
  // existing `Bearer admin-secret` requests below keep verifying.
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

test('code exchange → submit intake happy path with CSRF', async () => {
  const { app, db } = makeApp();
  const { code } = issueAccessCode(db, 'QA A');

  const login = await call(app, 'POST', '/api/intake/session', {
    headers: { 'content-type': 'application/json', origin: 'https://intake.lan' },
    body: JSON.stringify({ code }),
  });
  assert.equal(login.status, 200);
  const csrf = login.body.csrfToken;
  const sid = /intake_sid=([^;]+)/.exec(login.cookie || '')![1];

  const submit = await call(app, 'POST', '/api/intake/intakes', {
    headers: {
      'content-type': 'application/json', origin: 'https://intake.lan',
      'x-csrf-token': csrf, cookie: `intake_sid=${sid}`, 'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify({ title: 'Login crash', body: 'repro steps here' }),
  });
  assert.equal(submit.status, 201);
  assert.equal(submit.body.displayStatus, 'Submitted');
  assert.equal('state' in submit.body, false);
});

test('no tester response leaks internal fields (POST, list, detail)', async () => {
  const { app, db } = makeApp();
  const { code } = issueAccessCode(db, 'QA C');

  async function loginAndGetSession() {
    const login = await call(app, 'POST', '/api/intake/session', {
      headers: { 'content-type': 'application/json', origin: 'https://intake.lan' },
      body: JSON.stringify({ code }),
    });
    const csrf = login.body.csrfToken;
    const sid = /intake_sid=([^;]+)/.exec(login.cookie || '')![1];
    return { csrf, sid };
  }

  const { csrf, sid } = await loginAndGetSession();

  const submit = await call(app, 'POST', '/api/intake/intakes', {
    headers: {
      'content-type': 'application/json', origin: 'https://intake.lan',
      'x-csrf-token': csrf, cookie: `intake_sid=${sid}`, 'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify({ title: 'Leak check', body: 'repro steps here' }),
  });
  assert.equal(submit.status, 201);
  const postBody = submit.body;
  const intakeId = postBody.id;

  const list = await call(app, 'GET', '/api/intake/intakes', {
    headers: { cookie: `intake_sid=${sid}` },
  });
  assert.equal(list.status, 200);
  const listBody = list.body[0];

  const detail = await call(app, 'GET', `/api/intake/intakes/${intakeId}`, {
    headers: { cookie: `intake_sid=${sid}` },
  });
  assert.equal(detail.status, 200);
  const detailBody = detail.body;

  const forbidden = ['tester_id', 'state', 'revision', 'change_seq', 'idempotency_key'];
  for (const body of [postBody, listBody, detailBody]) {
    for (const k of forbidden) assert.equal(k in body, false, `${k} leaked`);
    assert.equal(typeof body.displayStatus, 'string');
    for (const raw of ['submitted', 'triaged', 'needs_scope_review', 'ai_failed', 'decided', 'promoted', 'closed']) {
      assert.equal(JSON.stringify(body).includes(`"state":"${raw}"`), false);
    }
  }
});

test('submit without CSRF token is rejected 403', async () => {
  const { app, db } = makeApp();
  const { code } = issueAccessCode(db, 'QA B');
  const login = await call(app, 'POST', '/api/intake/session', {
    headers: { 'content-type': 'application/json', origin: 'https://intake.lan' },
    body: JSON.stringify({ code }),
  });
  const sid = /intake_sid=([^;]+)/.exec(login.cookie || '')![1];
  const submit = await call(app, 'POST', '/api/intake/intakes', {
    headers: { 'content-type': 'application/json', origin: 'https://intake.lan', cookie: `intake_sid=${sid}` },
    body: JSON.stringify({ title: 'x', body: 'y' }),
  });
  assert.equal(submit.status, 403);
});

test('logout requires CSRF; code exchange does not', async () => {
  const { app, db } = makeApp();
  const { code } = issueAccessCode(db, 'QA D');

  const login = await call(app, 'POST', '/api/intake/session', {
    headers: { 'content-type': 'application/json', origin: 'https://intake.lan' },
    body: JSON.stringify({ code }),
  });
  assert.equal(login.status, 200); // code exchange stays CSRF-exempt
  const csrf = login.body.csrfToken;
  const sid = /intake_sid=([^;]+)/.exec(login.cookie || '')![1];

  const logoutNoCsrf = await call(app, 'DELETE', '/api/intake/session', {
    headers: { origin: 'https://intake.lan', cookie: `intake_sid=${sid}`, 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(logoutNoCsrf.status, 403);

  const logoutWithCsrf = await call(app, 'DELETE', '/api/intake/session', {
    headers: {
      origin: 'https://intake.lan', cookie: `intake_sid=${sid}`,
      'x-csrf-token': csrf, 'sec-fetch-site': 'same-origin',
    },
  });
  assert.equal(logoutWithCsrf.status, 204);
});

test('bad code returns generic 401 (no enumeration)', async () => {
  const { app } = makeApp();
  const r = await call(app, 'POST', '/api/intake/session', {
    headers: { 'content-type': 'application/json', origin: 'https://intake.lan' },
    body: JSON.stringify({ code: 'definitely-wrong' }),
  });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'Invalid code'); // same message regardless of reason
});

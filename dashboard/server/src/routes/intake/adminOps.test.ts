import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../../intake/db';
import { runMigrations } from '../../intake/migrations';
import { provisionAdminCredential } from '../../intake/adminCredentialStore';
import { WindowLimiter } from '../../intake/rateLimiter';
import { buildAdminOpsRouter } from './adminOps';

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

function makeApp(db: any, codeExchangeLimiter: WindowLimiter, submissionLimiter: WindowLimiter) {
  const app = express();
  app.use('/api/intake/admin', buildAdminOpsRouter(db, { codeExchangeLimiter, submissionLimiter }));
  return app;
}

test('GET /api/intake/admin/throttled reports keys over the limit on the injected limiters', async () => {
  const db = openDb(':memory:');
  runMigrations(db);
  provisionAdminCredential(db, { label: 'test', secret: 'admin-secret', capabilities: ['intake:admin'] });

  const codeExchangeLimiter = new WindowLimiter({ windowMs: 1000, maxAttempts: 1 });
  const submissionLimiter = new WindowLimiter({ windowMs: 1000, maxAttempts: 5 });
  // Drive the SAME injected instance over its limit, as the auth route would.
  const now = Date.now();
  codeExchangeLimiter.hit('1.2.3.4', now);
  codeExchangeLimiter.hit('1.2.3.4', now); // over the limit

  const app = makeApp(db, codeExchangeLimiter, submissionLimiter);

  const ok = await call(app, '/api/intake/admin/throttled', { authorization: 'Bearer admin-secret' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.codeExchange.length, 1);
  assert.equal(ok.body.codeExchange[0].key, '1.2.3.4');
  assert.equal(ok.body.codeExchange[0].attempts, 2);
  assert.equal(ok.body.submission.length, 0);
});

test('GET /api/intake/admin/throttled requires the intake:admin capability', async () => {
  const db = openDb(':memory:');
  runMigrations(db);
  provisionAdminCredential(db, { label: 'no-admin-cap', secret: 'reader-secret', capabilities: ['intake:read'] });

  const app = makeApp(db, new WindowLimiter({ windowMs: 1000, maxAttempts: 1 }), new WindowLimiter({ windowMs: 1000, maxAttempts: 1 }));

  const noAuth = await call(app, '/api/intake/admin/throttled');
  assert.equal(noAuth.status, 401);

  const wrongCap = await call(app, '/api/intake/admin/throttled', { authorization: 'Bearer reader-secret' });
  assert.equal(wrongCap.status, 403);

  const invalid = await call(app, '/api/intake/admin/throttled', { authorization: 'Bearer nope' });
  assert.equal(invalid.status, 401);
});

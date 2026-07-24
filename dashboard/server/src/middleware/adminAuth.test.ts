import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../intake/db';
import { runMigrations } from '../intake/migrations';
import { provisionAdminCredential } from '../intake/adminCredentialStore';
import { makeAdminAuth } from './adminAuth';

function res() {
  return { statusCode: 0, body: null as any,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; }, end() { return this; } };
}

test('hard-fails 503 when no credential is configured (mode required)', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const mw = makeAdminAuth(db, { mode: 'required' });
  const r = res(); let n = false;
  mw({ headers: {} } as any, r as any, () => { n = true; });
  assert.equal(r.statusCode, 503); assert.equal(n, false);
});

test('accepts a valid header bearer with the required capability; rejects query token and missing capability', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const { secret } = provisionAdminCredential(db, { label: 'm', capabilities: ['intake:promote'] });
  const mw = makeAdminAuth(db, { mode: 'required', requiredCapability: 'intake:promote' });

  // query token is NOT accepted
  const r1 = res(); let n1 = false;
  mw({ headers: {}, query: { token: secret } } as any, r1 as any, () => { n1 = true; });
  assert.equal(r1.statusCode, 401); assert.equal(n1, false);

  // valid header bearer with capability
  const r2 = res(); let n2 = false;
  mw({ headers: { authorization: `Bearer ${secret}` } } as any, r2 as any, () => { n2 = true; });
  assert.equal(n2, true);

  // valid credential but WRONG capability
  const mw2 = makeAdminAuth(db, { mode: 'required', requiredCapability: 'intake:admin' });
  const r3 = res(); let n3 = false;
  mw2({ headers: { authorization: `Bearer ${secret}` } } as any, r3 as any, () => { n3 = true; });
  assert.equal(r3.statusCode, 403); assert.equal(n3, false);
});

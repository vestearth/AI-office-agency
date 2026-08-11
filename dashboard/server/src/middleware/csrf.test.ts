import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCsrfGuard } from './csrf';
import { DEFAULT_ALLOWED_ORIGINS } from '../config';

function res() {
  return { statusCode: 0, body: null as any,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; } };
}
const guard = makeCsrfGuard({ allowedOrigins: ['https://intake.lan'] });

test('default dev origins allow Vite on its first fallback port', () => {
  assert.ok(DEFAULT_ALLOWED_ORIGINS.includes('http://localhost:3000'));
  assert.ok(DEFAULT_ALLOWED_ORIGINS.includes('http://localhost:3001'));
});

test('GET passes without token', () => {
  let n = false;
  guard({ method: 'GET', headers: {}, tester: { csrfToken: 't' } } as any, res() as any, () => { n = true; });
  assert.equal(n, true);
});

test('POST rejects bad origin, bad token, and passes when both valid', () => {
  const base = { method: 'POST', tester: { csrfToken: 'good-token' } };
  // bad origin
  const r1 = res(); let n1 = false;
  guard({ ...base, headers: { origin: 'https://evil.lan', 'x-csrf-token': 'good-token' } } as any, r1 as any, () => { n1 = true; });
  assert.equal(r1.statusCode, 403); assert.equal(n1, false);
  // good origin, bad token
  const r2 = res(); let n2 = false;
  guard({ ...base, headers: { origin: 'https://intake.lan', 'x-csrf-token': 'wrong' } } as any, r2 as any, () => { n2 = true; });
  assert.equal(r2.statusCode, 403); assert.equal(n2, false);
  // good origin, good token, good fetch-site
  const r3 = res(); let n3 = false;
  guard({ ...base, headers: { origin: 'https://intake.lan', 'x-csrf-token': 'good-token', 'sec-fetch-site': 'same-origin' } } as any, r3 as any, () => { n3 = true; });
  assert.equal(n3, true);
});

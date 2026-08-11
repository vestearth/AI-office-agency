import { test } from 'vitest';
import assert from 'node:assert/strict';
import { newIdempotencyKey, makeIntakeApi } from './intakeApi';

test('idempotency keys are unique non-empty strings', () => {
  const a = newIdempotencyKey(), b = newIdempotencyKey();
  assert.notEqual(a, b); assert.ok(a.length >= 8);
});

test('session exchange and resume capture csrf; submitIntake reuses it', async () => {
  const calls: any[] = [];
  let csrf = '';
  const fakeFetch = async (url: string, opts: any) => {
    calls.push({ url, opts });
    if (url.endsWith('/session')) {
      const csrfToken = opts.method === 'GET' ? 'RESUMED' : 'CT';
      return { ok: true, status: 200, json: async () => ({ csrfToken, expiresAt: 1 }) } as any;
    }
    return { ok: true, status: 201, json: async () => ({ id: 'INTAKE-1' }) } as any;
  };
  const api = makeIntakeApi({ fetchImpl: fakeFetch as any, getCsrf: () => csrf, setCsrf: (t) => { csrf = t; } });
  await api.exchangeCode('CODE');
  assert.equal(csrf, 'CT');
  await api.resumeSession();
  assert.equal(csrf, 'RESUMED');
  await api.submitIntake({ title: 'x', body: 'y', idempotencyKey: 'k' });
  const resume = calls[1];
  assert.equal(resume.opts.method, 'GET');
  assert.equal(resume.opts.credentials, 'include');
  const submit = calls[2];
  assert.equal(submit.opts.credentials, 'include');
  assert.equal(submit.opts.headers['X-CSRF-Token'], 'RESUMED');
  assert.match(submit.url, /\/api\/intake\/intakes$/);
});

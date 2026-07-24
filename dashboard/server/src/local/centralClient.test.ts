import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCentralClient } from './centralClient';

test('getChanges calls the changes endpoint with the bearer token and since cursor', async () => {
  const calls: any[] = [];
  const fakeFetch = async (url: string, opts: any) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ changes: [], nextCursor: 0 }) } as any;
  };
  const client = makeCentralClient({ baseUrl: 'https://central.lan', adminToken: 'admin-secret', fetchImpl: fakeFetch as any });
  await client.getChanges(7);
  assert.match(calls[0].url, /\/api\/intake\/changes\?since=7/);
  assert.equal(calls[0].opts.headers.authorization, 'Bearer admin-secret');
});

test('never puts the bearer token in the URL', async () => {
  const calls: any[] = [];
  const fakeFetch = async (url: string, opts: any) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({}) } as any;
  };
  const client = makeCentralClient({ baseUrl: 'https://central.lan', adminToken: 'top-secret-token', fetchImpl: fakeFetch as any });
  await client.getChanges(0);
  await client.claim('intake-1', 'owner-a', 3);
  for (const call of calls) {
    assert.doesNotMatch(call.url, /top-secret-token/);
  }
});

test('claim posts owner and expectedRevision with bearer auth', async () => {
  const calls: any[] = [];
  const fakeFetch = async (url: string, opts: any) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
  };
  const client = makeCentralClient({ baseUrl: 'https://central.lan', adminToken: 'secret', fetchImpl: fakeFetch as any });
  await client.claim('intake-42', 'owner-b', 5);
  assert.match(calls[0].url, /\/api\/intake\/intakes\/intake-42\/claim$/);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer secret');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.owner, 'owner-b');
  assert.equal(body.expectedRevision, 5);
});

test('non-2xx response throws a descriptive Error including the status', async () => {
  const fakeFetch = async () =>
    ({ ok: false, status: 409, text: async () => 'revision mismatch' } as any);
  const client = makeCentralClient({ baseUrl: 'https://central.lan', adminToken: 'secret', fetchImpl: fakeFetch as any });
  await assert.rejects(() => client.claim('intake-1', 'owner-a', 1), /409/);
});

test('importTriage and recordPromotion post to the expected paths', async () => {
  const calls: any[] = [];
  const fakeFetch = async (url: string, opts: any) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({}) } as any;
  };
  const client = makeCentralClient({ baseUrl: 'https://central.lan', adminToken: 'secret', fetchImpl: fakeFetch as any });
  await client.importTriage('intake-9', { foo: 'bar' });
  await client.recordPromotion('intake-9', { baz: 'qux' });
  assert.match(calls[0].url, /\/api\/intake\/intakes\/intake-9\/triage$/);
  assert.match(calls[1].url, /\/api\/intake\/intakes\/intake-9\/promotion$/);
});

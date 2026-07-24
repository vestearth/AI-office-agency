import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WindowLimiter, ByteBudget } from './rateLimiter';

test('WindowLimiter: allows up to maxAttempts then blocks with backoff, resets after window', () => {
  const lim = new WindowLimiter({ windowMs: 1000, maxAttempts: 3, backoffBaseMs: 100 });
  let now = 0;
  assert.equal(lim.hit('ip1', now).allowed, true);
  assert.equal(lim.hit('ip1', now).allowed, true);
  assert.equal(lim.hit('ip1', now).allowed, true);
  const blocked = lim.hit('ip1', now);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  // Different key is unaffected.
  assert.equal(lim.hit('ip2', now).allowed, true);
  // After the window elapses, the key is allowed again.
  now += 1001;
  assert.equal(lim.hit('ip1', now).allowed, true);
});

test('WindowLimiter: returns attempt count', () => {
  const lim = new WindowLimiter({ windowMs: 1000, maxAttempts: 2, backoffBaseMs: 50 });
  let now = 0;
  assert.equal(lim.hit('test', now).attempts, 1);
  assert.equal(lim.hit('test', now).attempts, 2);
  assert.equal(lim.hit('test', now).attempts, 3);
  assert.equal(lim.hit('test', now).attempts, 4);
});

test('WindowLimiter: reset clears the bucket', () => {
  const lim = new WindowLimiter({ windowMs: 1000, maxAttempts: 2 });
  let now = 0;
  lim.hit('key1', now);
  lim.hit('key1', now);
  lim.hit('key1', now); // blocked
  lim.reset('key1');
  assert.equal(lim.hit('key1', now).allowed, true);
});

test('WindowLimiter: progressive backoff increases with attempt count', () => {
  const lim = new WindowLimiter({ windowMs: 1000, maxAttempts: 1, backoffBaseMs: 100 });
  let now = 0;
  lim.hit('key', now); // allowed
  const blocked2 = lim.hit('key', now); // 1 over limit
  const blocked3 = lim.hit('key', now); // 2 over limit
  assert.ok(blocked3.retryAfterMs > blocked2.retryAfterMs || blocked3.retryAfterMs === blocked2.retryAfterMs);
});

test('ByteBudget: allows charges within maxBytes', () => {
  const budget = new ByteBudget({ windowMs: 1000, maxBytes: 100 });
  let now = 0;
  assert.equal(budget.charge('user1', 50, now).allowed, true);
  assert.equal(budget.charge('user1', 40, now).allowed, true);
  assert.equal(budget.charge('user1', 20, now).allowed, false);
});

test('ByteBudget: resets after window elapses', () => {
  const budget = new ByteBudget({ windowMs: 1000, maxBytes: 100 });
  let now = 0;
  budget.charge('user1', 100, now);
  assert.equal(budget.charge('user1', 1, now).allowed, false);
  now += 1001;
  assert.equal(budget.charge('user1', 50, now).allowed, true);
});

test('ByteBudget: independent keys', () => {
  const budget = new ByteBudget({ windowMs: 1000, maxBytes: 100 });
  let now = 0;
  budget.charge('user1', 100, now);
  assert.equal(budget.charge('user2', 50, now).allowed, true);
});

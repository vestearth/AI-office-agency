import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashSecret, verifySecret, randomId, randomToken } from './crypto';

test('hash/verify round-trips and rejects wrong secret', () => {
  const { hash, salt } = hashSecret('correct horse');
  assert.equal(verifySecret('correct horse', hash, salt), true);
  assert.equal(verifySecret('wrong', hash, salt), false);
});

test('randomId is prefixed and unique; randomToken is hex', () => {
  const a = randomId('INTAKE');
  const b = randomId('INTAKE');
  assert.ok(a.startsWith('INTAKE-'));
  assert.notEqual(a, b);
  assert.match(randomToken(16), /^[0-9a-f]{32}$/);
});

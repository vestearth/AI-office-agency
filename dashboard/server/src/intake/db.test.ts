import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './db';

test('getDb returns null when better-sqlite3 is unavailable', () => {
  assert.equal(getDb(), null);
});

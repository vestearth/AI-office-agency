import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { readCursor, writeCursor } from './syncCursor';

test('cursor round-trips and defaults to 0 when absent', async () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cur-')), 'cursor.json');
  assert.equal(await readCursor(p), 0);
  await writeCursor(p, 42);
  assert.equal(await readCursor(p), 42);
});

test('readCursor returns 0 for corrupt file instead of throwing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cur-'));
  const p = path.join(dir, 'cursor.json');
  fs.writeFileSync(p, 'not json{{{');
  assert.equal(await readCursor(p), 0);
});

test('writeCursor creates the parent directory if missing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cur-'));
  const p = path.join(dir, 'nested', 'deeper', 'cursor.json');
  await writeCursor(p, 7);
  assert.equal(await readCursor(p), 7);
});

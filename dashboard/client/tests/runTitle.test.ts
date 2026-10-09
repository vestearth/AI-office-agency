import assert from 'node:assert/strict';
import { test } from 'vitest';
import { distinctTitle } from '../src/views/runTitle.ts';

test('distinctTitle returns a real title next to its task id', () => {
  assert.equal(distinctTitle('TASK-EAR-385', 'Player Game Favorites'), 'Player Game Favorites');
});

test('distinctTitle hides a title that only repeats the task id', () => {
  assert.equal(distinctTitle('TASK-EAR-385', 'TASK-EAR-385'), null);
  assert.equal(distinctTitle('TASK-EAR-385', '  '), null);
  assert.equal(distinctTitle('TASK-EAR-385', undefined), null);
});

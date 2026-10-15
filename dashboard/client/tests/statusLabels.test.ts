import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RunStatus } from '../../shared/types';
import { STATUS_LABEL, statusLabel } from '../../shared/statusLabels.ts';

test('every RunStatus has one human label; running reads In progress', () => {
  const all: RunStatus[] = ['queued', 'running', 'waiting_review', 'blocked', 'failed', 'completed', 'cancelled', 'unknown'];
  assert.deepEqual(Object.keys(STATUS_LABEL).sort(), [...all].sort());
  assert.equal(statusLabel('running'), 'In progress');
  assert.equal(statusLabel('waiting_review'), 'In review');
  assert.equal(statusLabel('completed'), 'Done');
  assert.equal(statusLabel('cancelled'), 'Aborted');
  assert.equal(statusLabel('failed'), 'Validation failed');
});

test('an unknown or missing status reads Unreadable, never the raw value', () => {
  assert.equal(statusLabel(undefined), 'Unreadable');
  assert.equal(statusLabel('weird_phase'), 'Unreadable');
});

test('phaseLabel names phases with the shared vocabulary and humanizes unknown ones', async () => {
  const { phaseLabel } = await import('../../shared/statusLabels');
  assert.equal(phaseLabel('assigned'), 'Assigned');
  assert.equal(phaseLabel('in_review'), 'In review');
  assert.equal(phaseLabel('pending'), 'Queued');
  assert.equal(phaseLabel('some_new_phase'), 'Some new phase');
  assert.equal(phaseLabel(null), 'Unknown');
});

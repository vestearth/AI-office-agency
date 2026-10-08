import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { GateEntry } from '../../shared/types';
import { gateTone, safeRunUrl } from '../src/views/gateDisplay.ts';

function gate(entry: Partial<GateEntry>): GateEntry {
  return {
    name: 'g', status: 'pending', resolved: false, waitsOn: [], requiresAuthorization: null, grant: null,
    requiresRecord: false, ran: null, passable: false, unresolvedReason: null, detail: '', ...entry,
  };
}

test('gateTone: a resolved pass or na reads as done, an unresolved one as a problem', () => {
  assert.equal(gateTone(gate({ status: 'pass', resolved: true })), 'resolved');
  assert.equal(gateTone(gate({ status: 'na', resolved: true })), 'na');
  assert.equal(gateTone(gate({ status: 'pass', resolved: false, unresolvedReason: 'missing ran record' })), 'unresolved');
  assert.equal(gateTone(gate({ status: 'na', resolved: false, unresolvedReason: 'authorization not satisfied' })), 'unresolved');
});

test('gateTone: pending is pending whether or not it can pass now; an unknown status is a problem', () => {
  assert.equal(gateTone(gate({ status: 'pending', passable: true })), 'pending');
  assert.equal(gateTone(gate({ status: 'pending', passable: false })), 'pending');
  assert.equal(gateTone(gate({ status: 'skipped' })), 'unresolved');
});

test('safeRunUrl links only http and https', () => {
  assert.equal(safeRunUrl('https://github.com/o/r/actions/runs/1'), 'https://github.com/o/r/actions/runs/1');
  assert.equal(safeRunUrl('http://localhost:8080/run'), 'http://localhost:8080/run');
  for (const value of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', '/relative/path', 'not a url', '', undefined, null, 42]) {
    assert.equal(safeRunUrl(value), null, String(value));
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkTaskContract, TaskContractCache } from './taskContract';
import type { OfficeLaunch } from '../../../shared/types';

const launch = (startedAt: string): OfficeLaunch => ({
  id: 'l1', kind: 'task', key: 'TASK-EAR-1', label: 'TASK-EAR-1 dev', role: 'dev', command: '', cwd: '/', startedAt,
  status: 'succeeded', exitCode: 0, log: '', truncated: false,
});

function runDir(outputAt?: Date, statusAt?: Date) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-contract-'));
  for (const [name, at] of [['dev-output.yaml', outputAt], ['status.yaml', statusAt]] as const) {
    if (!at) continue;
    fs.writeFileSync(path.join(dir, name), 'x');
    fs.utimesSync(path.join(dir, name), at, at);
  }
  return dir;
}
const pass = async () => ({ ok: true, output: 'Validation passed' });

test('met only when the output and status changed during the run and validation passes', async () => {
  const start = '2026-10-16T09:00:00Z';
  const after = new Date('2026-10-16T09:10:00Z');
  const before = new Date('2026-10-16T08:00:00Z');
  assert.equal((await checkTaskContract(launch(start), runDir(after, after), pass)).met, true);

  const stale = await checkTaskContract(launch(start), runDir(before, after), pass);
  assert.deepEqual([stale.met, stale.outputWritten, stale.statusSynced], [false, false, true]);

  const unsynced = await checkTaskContract(launch(start), runDir(after, before), pass);
  assert.deepEqual([unsynced.met, unsynced.statusSynced], [false, false]);

  const invalid = await checkTaskContract(launch(start), runDir(after, after), async () => ({ ok: false, output: 'missing next_action' }));
  assert.equal(invalid.met, false);
  assert.equal(invalid.validation.output, 'missing next_action');

  const missing = await checkTaskContract(launch(start), runDir(), pass);
  assert.deepEqual([missing.outputFile, missing.outputWritten], ['dev-output.yaml', false]);
});

test('a finished launch is validated once', async () => {
  let calls = 0;
  const cache = new TaskContractCache();
  const dir = runDir();
  const validate = async () => { calls++; return { ok: true, output: '' }; };
  await cache.get(launch('2026-10-16T09:00:00Z'), dir, validate);
  await cache.get(launch('2026-10-16T09:00:00Z'), dir, validate);
  assert.equal(calls, 1);
});

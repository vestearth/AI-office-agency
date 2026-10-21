import test from 'node:test';
import assert from 'node:assert/strict';
import { run, scriptEnv } from './officeScripts';

test('a script gets no history operator from the dashboard: not the variable, not a harness marker', () => {
  const base = { PATH: '/bin', AI_DEV_OFFICE_HISTORY_OPERATOR: 'claude', CLAUDECODE: '1', CODEX_THREAD_ID: 't1', CURSOR_AGENT: '1' };
  assert.deepEqual(scriptEnv({}, base), { PATH: '/bin' });
});

test('an operator the caller passes explicitly still reaches the script', () => {
  assert.deepEqual(scriptEnv({ AI_DEV_OFFICE_HISTORY_OPERATOR: 'codex' }, { PATH: '/bin', CLAUDECODE: '1' }),
    { PATH: '/bin', AI_DEV_OFFICE_HISTORY_OPERATOR: 'codex' });
});

test('a script that exits without reading its stdin resolves with its exit code, not an unhandled EPIPE', async () => {
  // 2026-10-21, a loaded full run: decide-next-step.rb exited before run() had written its
  // stdin, and the write raised an unhandled EPIPE (chainOffice.test.ts). 4 MB is more than
  // the pipe holds, so the write is still pending when the child exits.
  const result = await run(process.execPath, ['-e', 'process.exit(3)'], { cwd: process.cwd(), stdin: 'x'.repeat(4 * 1024 * 1024) });
  assert.equal(result.code, 3);
});

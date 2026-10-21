import test from 'node:test';
import assert from 'node:assert/strict';
import { scriptEnv } from './officeScripts';

test('a script gets no history operator from the dashboard: not the variable, not a harness marker', () => {
  const base = { PATH: '/bin', AI_DEV_OFFICE_HISTORY_OPERATOR: 'claude', CLAUDECODE: '1', CODEX_THREAD_ID: 't1', CURSOR_AGENT: '1' };
  assert.deepEqual(scriptEnv({}, base), { PATH: '/bin' });
});

test('an operator the caller passes explicitly still reaches the script', () => {
  assert.deepEqual(scriptEnv({ AI_DEV_OFFICE_HISTORY_OPERATOR: 'codex' }, { PATH: '/bin', CLAUDECODE: '1' }),
    { PATH: '/bin', AI_DEV_OFFICE_HISTORY_OPERATOR: 'codex' });
});

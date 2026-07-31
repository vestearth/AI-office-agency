import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSocraticodeStatus, parseSocraticodeStatusPayload } from './socraticodeStatus';

test('parseSocraticodeStatusPayload reports active remote backend details', () => {
  const status = parseSocraticodeStatusPayload(
    JSON.stringify({
      type: 'success',
      method: 'codebase_status',
      backend: 'remote',
      attemptedBackends: ['remote'],
      projectPath: 'D:\\llm',
      status: 'active',
      message: 'Codebase is indexed and ready',
    })
  );

  assert.equal(status.status, 'active');
  assert.equal(status.backend, 'remote');
  assert.deepEqual(status.attemptedBackends, ['remote']);
  assert.equal(status.projectPath, 'D:\\llm');
  assert.equal(status.message, 'Codebase is indexed and ready');
  assert.match(status.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('parseSocraticodeStatusPayload reports unavailable for error payloads', () => {
  const status = parseSocraticodeStatusPayload(
    JSON.stringify({
      type: 'error',
      method: 'codebase_status',
      attemptedBackends: ['remote', 'local-docker'],
      error: 'Remote and local Docker SocratiCode are unavailable.',
    })
  );

  assert.equal(status.status, 'unavailable');
  assert.equal(status.backend, 'none');
  assert.deepEqual(status.attemptedBackends, ['remote', 'local-docker']);
  assert.equal(status.message, 'Remote and local Docker SocratiCode are unavailable.');
});

test('parseSocraticodeStatusPayload tolerates PowerShell progress noise after JSON', () => {
  const status = parseSocraticodeStatusPayload([
    '{"type":"success","method":"codebase_status","message":"Codebase is indexed and ready","status":"active"}',
    '#< CLIXML',
    '<Objs><Obj S="progress"></Obj></Objs>',
  ].join('\n'));

  assert.equal(status.status, 'active');
  assert.equal(status.backend, 'remote');
  assert.equal(status.message, 'Codebase is indexed and ready');
});

test('buildSocraticodeStatus reports skipped when wrapper is not configured', async () => {
  const status = await buildSocraticodeStatus('');

  assert.equal(status.status, 'skipped');
  assert.equal(status.backend, 'none');
});

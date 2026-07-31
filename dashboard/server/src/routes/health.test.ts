import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHealthStatus } from './health';

test('buildHealthStatus includes diagnostics needed to inspect dashboard wiring', () => {
  const status = buildHealthStatus({
    aiOfficeRoot: '/workspace/ai-dev-office',
    runsDir: '/workspace/ai-dev-office/runs',
    logsDir: '/workspace/ai-dev-office/logs',
    port: 4310,
    sseHeartbeatMs: 15000,
    logTailLines: 500,
    runsDirExists: true,
    logsDirExists: false,
    watcherActive: true,
    socraticode: {
      status: 'active',
      backend: 'remote',
      attemptedBackends: ['remote'],
      projectPath: 'D:\\llm',
      checkedAt: '2026-06-08T00:00:00.000Z',
      message: 'Codebase is indexed and ready',
    },
  });

  assert.equal(status.ok, true);
  assert.equal(status.status, 'ok'); // missing top-level logs/ is not a warning (logs are per-task)
  assert.equal(status.paths.runsDir, '/workspace/ai-dev-office/runs');
  assert.equal(status.config.logTailLines, 500);
  assert.equal(status.watcher.active, true);
  assert.equal(status.socraticode.status, 'active');
  assert.equal(status.socraticode.backend, 'remote');
  assert.deepEqual(status.socraticode.attemptedBackends, ['remote']);
  assert.equal(status.socraticode.projectPath, 'D:\\llm');
  assert.match(status.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('buildHealthStatus returns error when runs directory is missing', () => {
  const status = buildHealthStatus({
    aiOfficeRoot: '/workspace/ai-dev-office',
    runsDir: '/workspace/ai-dev-office/runs',
    logsDir: '/workspace/ai-dev-office/logs',
    port: 4310,
    sseHeartbeatMs: 15000,
    logTailLines: 500,
    runsDirExists: false,
    logsDirExists: true,
    watcherActive: true,
  });

  assert.equal(status.ok, false);
  assert.equal(status.status, 'error');
});

test('buildHealthStatus returns warning when watcher is inactive', () => {
  const status = buildHealthStatus({
    aiOfficeRoot: '/workspace/ai-dev-office',
    runsDir: '/workspace/ai-dev-office/runs',
    logsDir: '/workspace/ai-dev-office/logs',
    port: 4310,
    sseHeartbeatMs: 15000,
    logTailLines: 500,
    runsDirExists: true,
    logsDirExists: true,
    watcherActive: false,
  });

  assert.equal(status.ok, true);
  assert.equal(status.status, 'warning');
});

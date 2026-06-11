import { Router } from 'express';
import { config } from '../config';
import { globalWatcher } from '../services/watcher';
import { TASK_ID_PATTERN } from '../pathSecurity';
import { buildSocraticodeStatus } from '../services/socraticodeStatus';
import type { HealthStatus, SocraticodeStatus } from '@shared/types';
import fs from 'fs/promises';
import path from 'path';

const router = Router();

export interface HealthStatusInput {
  aiOfficeRoot: string;
  runsDir: string;
  logsDir: string;
  port: number;
  sseHeartbeatMs: number;
  logTailLines: number;
  runsDirExists: boolean;
  logsDirExists: boolean;
  watcherActive: boolean;
  watcherDebounceMs?: number;
  totalRuns?: number;
  socraticode?: SocraticodeStatus;
  error?: string;
}

function resolveHealthSeverity(input: HealthStatusInput): HealthStatus['status'] {
  if (!input.runsDirExists || input.error) {
    return 'error';
  }
  // A missing top-level logs/ dir is normal here — logs live per-task under
  // runs/<id>/*.log. Only the watcher being down is an actual warning.
  if (!input.watcherActive) {
    return 'warning';
  }
  return 'ok';
}

export function buildHealthStatus(input: HealthStatusInput): HealthStatus {
  const status = resolveHealthSeverity(input);
  return {
    ok: input.runsDirExists,
    status,
    aiOfficeRoot: input.aiOfficeRoot,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    totalRuns: input.totalRuns,
    runsDirExists: input.runsDirExists,
    logsDirExists: input.logsDirExists,
    watcherActive: input.watcherActive,
    paths: {
      runsDir: input.runsDir,
      logsDir: input.logsDir,
    },
    config: {
      port: input.port,
      sseHeartbeatMs: input.sseHeartbeatMs,
      logTailLines: input.logTailLines,
    },
    watcher: {
      active: input.watcherActive,
      debounceMs: input.watcherDebounceMs ?? 0,
    },
    socraticode: input.socraticode ?? {
      status: 'skipped',
      backend: 'none',
      checkedAt: new Date().toISOString(),
      message: 'SocratiCode status was not checked.',
    },
    error: input.error,
  };
}

router.get('/', async (req, res) => {
  let runsDirExists = false;
  let logsDirExists = false;
  let totalRuns = 0;

  try {
    const entries = await fs.readdir(config.runsDir);
    runsDirExists = true;
    totalRuns = entries.filter(e => TASK_ID_PATTERN.test(e)).length;
  } catch (e) { }

  try {
    await fs.access(config.logsDir);
    logsDirExists = true;
  } catch (e) { }

  const socraticode = await buildSocraticodeStatus(
    path.join(config.aiOfficeRoot, 'scripts', 'socraticode-tcp-wrapper.sh')
  ).catch((error): SocraticodeStatus => ({
    status: 'unavailable',
    backend: 'none',
    checkedAt: new Date().toISOString(),
    message: error instanceof Error ? error.message : 'SocratiCode status probe failed.',
  }));

  const status = buildHealthStatus({
    aiOfficeRoot: config.aiOfficeRoot,
    runsDir: config.runsDir,
    logsDir: config.logsDir,
    port: config.port,
    sseHeartbeatMs: config.sseHeartbeatMs,
    logTailLines: config.logTailLines,
    runsDirExists,
    logsDirExists,
    watcherActive: globalWatcher.isActive(),
    watcherDebounceMs: globalWatcher.getDebounceMs(),
    totalRuns,
    socraticode,
  });

  res.json(status);
});

export default router;

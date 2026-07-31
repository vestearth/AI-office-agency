import { execFile } from 'child_process';
import fs from 'fs/promises';
import type { SocraticodeStatus } from '@shared/types';

// The wrapper tries remote first and then falls back to local Docker. Three
// seconds can expire while the local fallback is still starting, even though it
// returns a healthy status shortly afterwards.
const PROBE_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 10000;
const SKIPPED_STATUS: SocraticodeStatus = {
  status: 'skipped',
  backend: 'none',
  checkedAt: new Date().toISOString(),
  message: 'SocratiCode wrapper is not configured for this dashboard runtime.',
};

type SocraticodePayload = {
  type?: string;
  backend?: string;
  attemptedBackends?: string[];
  projectPath?: string;
  project_path?: string;
  status?: string;
  message?: string;
  error?: string;
};

let cachedStatus: SocraticodeStatus | null = null;
let cachedWrapperPath = '';
let cachedUntil = 0;

function normalizeBackend(value: unknown): SocraticodeStatus['backend'] {
  if (value === 'remote' || value === 'local-docker') return value;
  return 'none';
}

function normalizeAttemptedBackends(value: unknown): SocraticodeStatus['attemptedBackends'] {
  if (!Array.isArray(value)) return undefined;
  const backends = value.filter(
    (backend): backend is Exclude<SocraticodeStatus['backend'], 'none'> =>
      backend === 'remote' || backend === 'local-docker'
  );
  return backends.length > 0 ? backends : undefined;
}

function configuredBackends(): NonNullable<SocraticodeStatus['attemptedBackends']> {
  switch (process.env.SOCRATICODE_BACKEND) {
    case 'remote':
      return ['remote'];
    case 'local':
      return ['local-docker'];
    default:
      return ['remote', 'local-docker'];
  }
}

function extractJsonPayload(payloadText: string): string {
  const trimmed = payloadText.trim();
  if (trimmed.startsWith('{')) {
    const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim();
    if (firstLine) return firstLine;
  }

  for (const line of trimmed.split(/\r?\n/)) {
    const candidate = line.trim();
    if (candidate.startsWith('{') && candidate.endsWith('}')) {
      return candidate;
    }
  }

  return trimmed;
}

function normalizeStatus(payload: SocraticodePayload): SocraticodeStatus['status'] {
  if (payload.type === 'success' && payload.status === 'active') return 'active';
  if (payload.type === 'success') return 'unknown';
  if (payload.type === 'error') return 'unavailable';
  return 'error';
}

export function parseSocraticodeStatusPayload(payloadText: string): SocraticodeStatus {
  const checkedAt = new Date().toISOString();

  try {
    const payload = JSON.parse(extractJsonPayload(payloadText)) as SocraticodePayload;
    const status = normalizeStatus(payload);
    const backend = status === 'active' || status === 'unknown'
      ? normalizeBackend(payload.backend || 'remote')
      : 'none';

    return {
      status,
      backend,
      attemptedBackends: normalizeAttemptedBackends(payload.attemptedBackends),
      projectPath: payload.projectPath || payload.project_path,
      checkedAt,
      message: payload.message || payload.error,
    };
  } catch (error) {
    return {
      status: 'error',
      backend: 'none',
      checkedAt,
      message: 'SocratiCode status returned invalid JSON.',
    };
  }
}

async function wrapperExists(wrapperPath: string): Promise<boolean> {
  try {
    await fs.access(wrapperPath);
    return true;
  } catch (error) {
    return false;
  }
}

async function probeSocraticodeStatus(wrapperPath: string): Promise<SocraticodeStatus> {
  if (!wrapperPath || !(await wrapperExists(wrapperPath))) {
    return { ...SKIPPED_STATUS, checkedAt: new Date().toISOString() };
  }

  return new Promise((resolve) => {
    try {
      execFile(
        wrapperPath,
        ['codebase_status'],
        {
          timeout: PROBE_TIMEOUT_MS,
          env: {
            ...process.env,
            SOCRATICODE_SSH_TIMEOUT: process.env.SOCRATICODE_SSH_TIMEOUT || '2',
          },
        },
        (error, stdout, stderr) => {
          if (stdout.trim()) {
            const status = parseSocraticodeStatusPayload(stdout.trim());
            resolve({
              ...status,
              attemptedBackends: status.attemptedBackends || (status.backend === 'remote'
                ? ['remote']
                : configuredBackends()),
            });
            return;
          }

          resolve({
            status: error?.killed ? 'error' : 'unavailable',
            backend: 'none',
            attemptedBackends: configuredBackends(),
            checkedAt: new Date().toISOString(),
            message: error?.killed
              ? 'SocratiCode status probe timed out.'
              : (stderr.trim() || error?.message || 'SocratiCode status probe did not return output.'),
          });
        }
      );
    } catch (error) {
      resolve({
        status: 'unavailable',
        backend: 'none',
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'SocratiCode status probe could not start.',
      });
    }
  });
}

export async function buildSocraticodeStatus(wrapperPath: string): Promise<SocraticodeStatus> {
  const now = Date.now();
  if (cachedStatus && cachedWrapperPath === wrapperPath && cachedUntil > now) {
    return cachedStatus;
  }

  const status = await probeSocraticodeStatus(wrapperPath);
  cachedStatus = status;
  cachedWrapperPath = wrapperPath;
  cachedUntil = now + CACHE_TTL_MS;
  return status;
}

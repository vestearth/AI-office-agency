import os from 'os';
import path from 'path';
import type { RepoRef } from '../local/repoProvenance';

export interface IntakeConfig {
  dataDir: string;
  attachmentDir: string;
  backupTarget: string;
  dbPath: string;
  sessionTtlMs: number;
  codeExchange: { windowMs: number; maxAttempts: number; backoffBaseMs: number };
  submission: { windowMs: number; maxPerWindow: number; maxUploadBytesPerWindow: number };
  attachment: {
    maxBytes: number;
    maxPerIntake: number;
    maxAggregateBytesPerIntake: number;
    allowedMime: string[];
  };
  storageHighWaterBytes: number;
  claimTtlMs: number;
  // Local-side (Phase B): where to reach Central's intake API, and the id this
  // machine reports as `owner` when claiming intakes. [PLAN-ASSUMPTION]
  centralBaseUrl: string;
  localMachineId: string;
  // Decision #5: closed set of repos an intake may be scoped to. Configured
  // by an operator only — tester-supplied text (e.g. product_hint) can never
  // extend this list at runtime. Default [] means no repo scoping is
  // possible until an operator configures INTAKE_REPO_ALLOWLIST.
  intakeRepoAllowlist: RepoRef[];
}

const int = (v: string | undefined, def: number) => {
  const n = parseInt((v ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

// Decision #7: PNG/JPEG/WebP/TXT/LOG only; reject archives/executables/video.
const DEFAULT_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'text/plain'];

// Parses INTAKE_REPO_ALLOWLIST (a JSON array of {name, path}). Malformed or
// malshaped input falls back to [] rather than throwing — an unparsable
// allowlist must mean "no repos reachable", never a crash or a guess.
export function parseRepoAllowlist(raw: string | undefined): RepoRef[] {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is RepoRef =>
        r && typeof r === 'object' && typeof r.name === 'string' && typeof r.path === 'string'
    );
  } catch {
    return [];
  }
}

export function loadIntakeConfig(env: NodeJS.ProcessEnv = process.env): IntakeConfig {
  const dataDir = (env.INTAKE_DATA_DIR || path.resolve(process.cwd(), 'intake-data')).trim();
  const attachmentDir = (env.INTAKE_ATTACHMENT_DIR || '').trim() || path.join(dataDir, 'attachments');
  return {
    dataDir,
    attachmentDir,
    backupTarget: (env.INTAKE_BACKUP_TARGET || path.join(dataDir, 'backups')).trim(),
    dbPath: path.join(dataDir, 'intake.sqlite'),
    sessionTtlMs: int(env.INTAKE_SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000), // 7 days (Decision #7)
    codeExchange: {
      windowMs: int(env.INTAKE_CODE_WINDOW_MS, 15 * 60 * 1000),
      maxAttempts: int(env.INTAKE_CODE_MAX_ATTEMPTS, 10),
      backoffBaseMs: int(env.INTAKE_CODE_BACKOFF_BASE_MS, 500),
    },
    submission: {
      windowMs: int(env.INTAKE_SUBMIT_WINDOW_MS, 60 * 60 * 1000),
      maxPerWindow: int(env.INTAKE_SUBMIT_MAX_PER_WINDOW, 20),
      maxUploadBytesPerWindow: int(env.INTAKE_SUBMIT_MAX_UPLOAD_BYTES, 50 * 1024 * 1024),
    },
    attachment: {
      maxBytes: int(env.INTAKE_ATTACHMENT_MAX_BYTES, 5 * 1024 * 1024),
      maxPerIntake: int(env.INTAKE_ATTACHMENT_MAX_PER_INTAKE, 10),
      maxAggregateBytesPerIntake: int(env.INTAKE_ATTACHMENT_MAX_AGGREGATE_BYTES, 20 * 1024 * 1024),
      allowedMime: [...DEFAULT_ALLOWED_MIME],
    },
    storageHighWaterBytes: int(env.INTAKE_STORAGE_HIGH_WATER_BYTES, 5 * 1024 * 1024 * 1024),
    claimTtlMs: int(env.INTAKE_CLAIM_TTL_MS, 30 * 60 * 1000), // 30 min default [PLAN-ASSUMPTION]
    centralBaseUrl: (env.INTAKE_CENTRAL_BASE_URL || '').trim(),
    localMachineId: (env.INTAKE_LOCAL_MACHINE_ID || os.hostname()).trim(),
    intakeRepoAllowlist: parseRepoAllowlist(env.INTAKE_REPO_ALLOWLIST),
  };
}

export const intakeConfig = loadIntakeConfig();

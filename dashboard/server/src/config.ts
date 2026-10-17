import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const AI_OFFICE_ROOT = process.env.AI_OFFICE_ROOT || path.resolve(__dirname, '../../..');
export const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:3000', 'http://localhost:3001'];

export interface DashboardConfig {
  aiOfficeRoot: string;
  runsDir: string;
  logsDir: string;
  knowledgeReviewsDir: string;
  port: number;
  sseHeartbeatMs: number;
  watcherDebounceMs: number;
  watcherMaxWaitMs: number;
  logTailLines: number;
  allowedOrigins: string[];
  authToken?: string;
  clientDistDir: string;
  /** Per-step time limit for Start-button launches (task steps and knowledge rounds). */
  stepTimeLimitMinutes: number;
  /** Knowledge re-check rounds: their own limit, longer than a task step's. */
  knowledgeTimeLimitMinutes: number;
  /** Where task worktrees live (<workspace>/.worktrees, the office lanes' convention) and the dashboard's registry of them. */
  worktreesDir: string;
  /** The Run queue's global concurrency cap (D13): launches running at once on this machine. */
  runConcurrency: number;
  /** The Run queue file (one per office root, beside the launches). */
  queueFile: string;
  /** The knowledge re-check chain's file (one per office root, beside the launches). */
  knowledgeChainFile: string;
}

/**
 * The launches dir (os.tmpdir()/ai-dev-office-dashboard/launches) is shared by every
 * dashboard server on this Mac; the queue and the knowledge chain are per office root,
 * so a second server with another root never starts or ends this one's items.
 */
const STATE_DIR = path.join(os.tmpdir(), 'ai-dev-office-dashboard', 'launches');
const ROOT_TAG = createHash('sha256').update(path.resolve(AI_OFFICE_ROOT)).digest('hex').slice(0, 12);

export const config: DashboardConfig = {
  aiOfficeRoot: AI_OFFICE_ROOT,
  runsDir: path.join(AI_OFFICE_ROOT, 'runs'),
  logsDir: path.join(AI_OFFICE_ROOT, 'logs'),
  knowledgeReviewsDir: path.join(AI_OFFICE_ROOT, 'knowledge-reviews'),
  port: parseInt(process.env.DASHBOARD_PORT || '4310', 10),
  sseHeartbeatMs: parseInt(process.env.SSE_HEARTBEAT_MS || '15000', 10),
  watcherDebounceMs: parseInt(process.env.WATCHER_DEBOUNCE_MS || '500', 10),
  // Upper bound on how long bursty writes can defer an SSE update.
  // Guarantees a flush within this window even under continuous file changes.
  watcherMaxWaitMs: parseInt(process.env.WATCHER_MAX_WAIT_MS || '5000', 10),
  logTailLines: parseInt(process.env.LOG_TAIL_LINES || '500', 10),
  // Comma-separated allowlist for CORS/CSRF. Vite falls back to 3001 when
  // 3000 is occupied, so both local dev origins must remain usable.
  allowedOrigins: (process.env.DASHBOARD_ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  // Shared bearer token for API access. When unset, auth is disabled (local dev).
  authToken: process.env.DASHBOARD_AUTH_TOKEN?.trim() || undefined,
  // Built client (`vite build`) output, serving the admin + intake pages
  // same-origin in production. In dev this dir won't exist — the Vite dev
  // server (port 3000) serves both entries instead; static serving is
  // guarded below to no-op when the dir is missing.
  clientDistDir: process.env.DASHBOARD_CLIENT_DIST_DIR || path.resolve(__dirname, '../../client/dist'),
  // A step past this is stopped and failed (the wrapper enforces it, so it holds
  // across a dashboard restart). Knowledge rounds took about 10 min on 2026-10-16.
  stepTimeLimitMinutes: Math.max(1, parseInt(process.env.DASHBOARD_STEP_TIME_LIMIT_MINUTES || '30', 10) || 30),
  knowledgeTimeLimitMinutes: Math.max(1, parseInt(process.env.DASHBOARD_KNOWLEDGE_TIME_LIMIT_MINUTES || '60', 10) || 60),
  // A Run's worktrees: <workspace root>/.worktrees/<repo>-<TASK> (docs/start-task-redesign-spec.md, D3).
  worktreesDir: process.env.DASHBOARD_WORKTREES_DIR || path.join(path.dirname(AI_OFFICE_ROOT), '.worktrees'),
  runConcurrency: Math.max(1, parseInt(process.env.DASHBOARD_RUN_CONCURRENCY || '2', 10) || 2),
  queueFile: process.env.DASHBOARD_QUEUE_FILE || path.join(STATE_DIR, `queue-${ROOT_TAG}.json`),
  knowledgeChainFile: process.env.DASHBOARD_KNOWLEDGE_CHAIN_FILE || path.join(STATE_DIR, `knowledge-chain-${ROOT_TAG}.json`),
};

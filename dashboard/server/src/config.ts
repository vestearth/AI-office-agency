import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const AI_OFFICE_ROOT = process.env.AI_OFFICE_ROOT || path.resolve(__dirname, '../../..');

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
}

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
  // Comma-separated allowlist for CORS. Defaults to the Vite dev origin.
  allowedOrigins: (process.env.DASHBOARD_ALLOWED_ORIGINS || 'http://localhost:3000')
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
};

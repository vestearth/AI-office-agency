import type { DB } from './db';
import { randomToken } from './crypto';
import { intakeConfig } from './config';

export function createSession(
  db: DB, testerId: string, now: number, ttlMs = intakeConfig.sessionTtlMs
): { sessionId: string; csrfToken: string; expiresAt: number } {
  const sessionId = randomToken(32);
  const csrfToken = randomToken(32);
  const expiresAt = now + ttlMs;
  db.prepare(
    'INSERT INTO session(id, tester_id, csrf_token, created_at, expires_at) VALUES(?, ?, ?, ?, ?)'
  ).run(sessionId, testerId, csrfToken, now, expiresAt);
  return { sessionId, csrfToken, expiresAt };
}

export function getValidSession(
  db: DB, sessionId: string, now: number
): { testerId: string; csrfToken: string } | null {
  const row = db
    .prepare('SELECT tester_id, csrf_token, expires_at, revoked_at FROM session WHERE id = ?')
    .get(sessionId) as any;
  if (!row || row.revoked_at != null || row.expires_at <= now) return null;
  return { testerId: row.tester_id, csrfToken: row.csrf_token };
}

export function revokeSession(db: DB, sessionId: string): void {
  db.prepare('UPDATE session SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), sessionId);
}

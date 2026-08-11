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
): { testerId: string; testerLabel: string; csrfToken: string; expiresAt: number } | null {
  const row = db
    .prepare(`SELECT s.tester_id, t.label AS tester_label, s.csrf_token, s.expires_at, s.revoked_at
                FROM session s
                JOIN tester t ON t.id = s.tester_id
               WHERE s.id = ? AND t.revoked_at IS NULL`)
    .get(sessionId) as any;
  if (!row || row.revoked_at != null || row.expires_at <= now) return null;
  return {
    testerId: row.tester_id,
    testerLabel: row.tester_label,
    csrfToken: row.csrf_token,
    expiresAt: row.expires_at,
  };
}

export function revokeSession(db: DB, sessionId: string): void {
  db.prepare('UPDATE session SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), sessionId);
}

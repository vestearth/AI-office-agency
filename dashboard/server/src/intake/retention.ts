import type { DB } from './db';
import { makeAttachmentStore } from './attachmentStore';
import { recordAudit } from './audit';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionPolicy {
  /** How long after an intake closes (updated_at while in a terminal state) before its attachments are deleted. */
  attachmentClosedMs?: number;
  /** How long after a session's expires_at before the row is hard-deleted. */
  sessionGraceMs?: number;
}

export interface RetentionOptions {
  now: number;
  attachmentDir: string;
  policy?: RetentionPolicy;
}

export interface RetentionResult {
  attachmentsDeleted: number;
  sessionsDeleted: number;
  errors: string[];
}

// Intake states considered terminal for the purposes of the attachment
// retention sweep (Decision #7). Structured intake rows are never deleted by
// this sweep regardless of state or age.
const TERMINAL_STATES = ['closed', 'promoted'];

// Retention sweep (Decision #7):
//  1. Attachments on closed/promoted intakes are deleted 90 days after the
//     intake's closure time (its updated_at while in the terminal state).
//  2. Sessions are hard-deleted 7 days past expires_at (they already stop
//     validating at expiry; this just clears the stale rows).
//  3. Structured data (intake/triage_result/decision/access_code/tester/
//     audit_event/promotion) is NEVER deleted here — purging structured data
//     older than 1 year is a separate future task that needs careful
//     foreign-key ordering and is explicitly out of scope for this sweep.
// `now` is injected so callers/tests are deterministic. Every deletion is
// wrapped so a single bad row can never throw into the caller (ops failures
// must never block the tester path) — failures are collected into `errors`.
export async function runRetention(db: DB, options: RetentionOptions): Promise<RetentionResult> {
  const { now, attachmentDir } = options;
  const attachmentClosedMs = options.policy?.attachmentClosedMs ?? 90 * DAY_MS;
  const sessionGraceMs = options.policy?.sessionGraceMs ?? 7 * DAY_MS;

  const errors: string[] = [];
  let attachmentsDeleted = 0;
  let sessionsDeleted = 0;

  // --- 1. Closed-intake attachments ---
  const attachmentStore = makeAttachmentStore({
    attachmentDir,
    caps: { maxBytes: 0, maxPerIntake: 0, maxAggregateBytesPerIntake: 0, allowedMime: [] },
  });

  const placeholders = TERMINAL_STATES.map(() => '?').join(',');
  const closureCutoff = now - attachmentClosedMs;
  const dueAttachments = db
    .prepare(
      `SELECT a.id AS id
       FROM attachment a
       JOIN intake i ON i.id = a.intake_id
       WHERE a.deleted_at IS NULL
         AND i.state IN (${placeholders})
         AND i.updated_at < ?`
    )
    .all(...TERMINAL_STATES, closureCutoff) as { id: string }[];

  for (const row of dueAttachments) {
    try {
      await attachmentStore.deleteAttachment(db, row.id, 'retention');
      attachmentsDeleted += 1;
    } catch (err) {
      errors.push(`attachment ${row.id}: ${(err as Error).message}`);
    }
  }

  // --- 2. Inactive sessions past their grace period ---
  const sessionCutoff = now - sessionGraceMs;
  const dueSessions = db
    .prepare(`SELECT id FROM session WHERE expires_at < ?`)
    .all(sessionCutoff) as { id: string }[];

  for (const row of dueSessions) {
    try {
      db.prepare('DELETE FROM session WHERE id = ?').run(row.id);
      sessionsDeleted += 1;
    } catch (err) {
      errors.push(`session ${row.id}: ${(err as Error).message}`);
    }
  }

  if (sessionsDeleted > 0) {
    recordAudit(db, {
      kind: 'retention_sessions_deleted',
      actorKind: 'system',
      detail: { count: sessionsDeleted },
    });
  }

  // --- 3. Structured data (intake/triage_result/decision/access_code/
  //         tester/audit_event/promotion) is intentionally untouched. ---

  return { attachmentsDeleted, sessionsDeleted, errors };
}

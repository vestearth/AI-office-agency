import type { DB } from './db';

export interface IntakeChange {
  intakeId: string; state: string; revision: number; changeSeq: number; updatedAt: number;
}

// Allocates the next global change sequence (SQLite has no native sequences).
// Caller MUST run this inside the same transaction as the row write.
export function nextChangeSeq(db: DB): number {
  db.prepare('UPDATE change_counter SET seq = seq + 1 WHERE id = 1').run();
  return (db.prepare('SELECT seq FROM change_counter WHERE id = 1').get() as any).seq;
}

export function stampIntakeChange(db: DB, intakeId: string): number {
  const seq = nextChangeSeq(db);
  db.prepare('UPDATE intake SET change_seq = ?, updated_at = ? WHERE id = ?').run(seq, Date.now(), intakeId);
  return seq;
}

export function listChangesSince(db: DB, cursor: number, limit = 100): { changes: IntakeChange[]; nextCursor: number } {
  const rows = db.prepare(
    `SELECT id AS intakeId, state, revision, change_seq AS changeSeq, updated_at AS updatedAt
     FROM intake WHERE change_seq > ? ORDER BY change_seq ASC LIMIT ?`
  ).all(cursor, limit) as IntakeChange[];
  const nextCursor = rows.length ? rows[rows.length - 1].changeSeq : cursor;
  return { changes: rows, nextCursor };
}

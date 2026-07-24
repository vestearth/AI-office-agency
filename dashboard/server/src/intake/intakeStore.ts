import type { DB } from './db';
import { randomId } from './crypto';
import { recordAudit } from './audit';

export interface IntakeRow {
  id: string; tester_id: string; title: string; body: string;
  product_hint: string | null; state: string; revision: number;
  created_at: number; updated_at: number;
}
export interface IntakeSummary {
  id: string; title: string; state: string; created_at: number; updated_at: number;
}

const MAX_TITLE = 200;
const MAX_BODY = 20_000;

export function submitIntake(
  db: DB,
  input: { testerId: string; title: string; body: string; productHint?: string; idempotencyKey?: string }
): { intake: IntakeRow; deduped: boolean } {
  const title = (input.title ?? '').trim();
  const body = (input.body ?? '').trim();
  if (!title || title.length > MAX_TITLE) throw new Error('title must be 1..200 chars');
  if (!body || body.length > MAX_BODY) throw new Error('body must be 1..20000 chars');

  if (input.idempotencyKey) {
    const existing = db
      .prepare('SELECT * FROM intake WHERE tester_id = ? AND idempotency_key = ?')
      .get(input.testerId, input.idempotencyKey) as IntakeRow | undefined;
    if (existing) return { intake: existing, deduped: true };
  }

  const now = Date.now();
  const id = randomId('INTAKE');
  db.prepare(
    `INSERT INTO intake(id, tester_id, title, body, product_hint, state, revision, idempotency_key, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, 'submitted', 1, ?, ?, ?)`
  ).run(id, input.testerId, title, body, input.productHint ?? null, input.idempotencyKey ?? null, now, now);
  recordAudit(db, { kind: 'intake_submitted', actorKind: 'tester', actorId: input.testerId, intakeId: id });
  return { intake: getIntake(db, id)!, deduped: false };
}

export function listIntakes(db: DB, filter: { testerId?: string } = {}): IntakeSummary[] {
  const rows = filter.testerId
    ? db.prepare('SELECT id,title,state,created_at,updated_at FROM intake WHERE tester_id = ? ORDER BY created_at DESC').all(filter.testerId)
    : db.prepare('SELECT id,title,state,created_at,updated_at FROM intake ORDER BY created_at DESC').all();
  return rows as IntakeSummary[];
}

export function getIntake(db: DB, id: string): IntakeRow | null {
  return (db.prepare('SELECT * FROM intake WHERE id = ?').get(id) as IntakeRow) ?? null;
}

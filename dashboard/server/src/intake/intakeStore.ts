import type { DB } from './db';
import { randomId } from './crypto';
import { recordAudit } from './audit';
import { stampIntakeChange } from './changesStore';

export interface IntakeRow {
  id: string; tester_id: string; title: string; body: string;
  product_hint: string | null; state: string; revision: number;
  created_at: number; updated_at: number;
  severity: string | null; repro_steps: string | null; expected: string | null;
  actual: string | null; environment: string | null;
}
export interface IntakeSummary {
  id: string; title: string; state: string; created_at: number; updated_at: number;
}

const MAX_TITLE = 200;
const MAX_BODY = 20_000;
const SEVERITIES = ['blocker', 'high', 'medium', 'low'];
const MAX_LONG = 8000;
const MAX_ENV = 1000;

export function submitIntake(
  db: DB,
  input: {
    testerId: string; title: string; body: string; productHint?: string; idempotencyKey?: string;
    severity?: string; reproSteps?: string; expected?: string; actual?: string; environment?: string;
  }
): { intake: IntakeRow; deduped: boolean } {
  const title = (input.title ?? '').trim();
  const body = (input.body ?? '').trim();
  if (!title || title.length > MAX_TITLE) throw new Error('title must be 1..200 chars');
  if (!body || body.length > MAX_BODY) throw new Error('body must be 1..20000 chars');

  const severity = input.severity?.trim() || null;
  if (severity && !SEVERITIES.includes(severity)) throw new Error(`severity must be one of ${SEVERITIES.join(', ')}`);
  const clip = (v: string | undefined, max: number, label: string) => {
    const s = (v ?? '').trim();
    if (s.length > max) throw new Error(`${label} must be <= ${max} chars`);
    return s || null;
  };
  const reproSteps = clip(input.reproSteps, MAX_LONG, 'reproSteps');
  const expected = clip(input.expected, MAX_LONG, 'expected');
  const actual = clip(input.actual, MAX_LONG, 'actual');
  const environment = clip(input.environment, MAX_ENV, 'environment');

  if (input.idempotencyKey) {
    const existing = db
      .prepare('SELECT * FROM intake WHERE tester_id = ? AND idempotency_key = ?')
      .get(input.testerId, input.idempotencyKey) as IntakeRow | undefined;
    if (existing) return { intake: existing, deduped: true };
  }

  const now = Date.now();
  const id = randomId('INTAKE');
  const insertAndStamp = db.transaction(() => {
    db.prepare(
      `INSERT INTO intake(id, tester_id, title, body, product_hint, state, revision, idempotency_key, created_at, updated_at, severity, repro_steps, expected, actual, environment)
       VALUES(?, ?, ?, ?, ?, 'submitted', 1, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, input.testerId, title, body, input.productHint ?? null, input.idempotencyKey ?? null, now, now,
      severity, reproSteps, expected, actual, environment
    );
    stampIntakeChange(db, id);
  });
  insertAndStamp();
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

const INTAKE_STATES = ['submitted', 'triaged', 'needs_scope_review', 'ai_failed', 'decided', 'promoted', 'closed'];

export function setIntakeState(
  db: DB, id: string, expectedRevision: number, newState: string
): { ok: true; revision: number } | { ok: false; reason: 'not_found' | 'revision_conflict' | 'bad_state' } {
  if (!INTAKE_STATES.includes(newState)) return { ok: false, reason: 'bad_state' };
  const row = getIntake(db, id);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.revision !== expectedRevision) return { ok: false, reason: 'revision_conflict' };
  const nextRev = row.revision + 1;
  const tx = db.transaction(() => {
    db.prepare('UPDATE intake SET state = ?, revision = ? WHERE id = ?').run(newState, nextRev, id);
    stampIntakeChange(db, id); // bumps change_seq + updated_at for the changes feed
  });
  tx();
  recordAudit(db, { kind: 'intake_state_changed', actorKind: 'admin', intakeId: id, detail: { from: row.state, to: newState } });
  return { ok: true, revision: nextRev };
}

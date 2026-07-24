import type { DB } from './db';
import { randomId } from './crypto';
import { getIntake, setIntakeState } from './intakeStore';
import { recordAudit } from './audit';

export interface PromotionRow {
  id: string; intake_id: string; task_id: string; projection_version: string;
  gate_overridden: number; created_at: number;
}

export function getPromotion(db: DB, intakeId: string): PromotionRow | null {
  return (db.prepare('SELECT * FROM promotion WHERE intake_id = ?').get(intakeId) as PromotionRow) ?? null;
}

// UNIQUE(intake_id) on the `promotion` table is the idempotency backstop: a
// retried/double promote for the same intake never mints a second TASK — it
// returns the ORIGINAL task id and never inserts a second row.
export function recordPromotion(
  db: DB,
  input: { intakeId: string; taskId: string; projectionVersion: string; gateOverridden: boolean }
): { created: boolean; taskId: string } {
  const existing = getPromotion(db, input.intakeId);
  if (existing) return { created: false, taskId: existing.task_id }; // idempotent

  try {
    // INSERT + setIntakeState(...'promoted') + recordAudit commit as one
    // atomic unit — a crash between the INSERT and the state flip must never
    // leave a promotion row whose intake is still stuck pre-'promoted'.
    // setIntakeState/recordAudit each open their own db.transaction(), but
    // better-sqlite3 transactions are reentrant (nested calls become
    // SAVEPOINTs against the same connection), so nesting them inside this
    // outer transaction is safe and still commits/rolls back as one unit.
    const insertAndPromote = db.transaction(() => {
      db.prepare(
        'INSERT INTO promotion(id,intake_id,task_id,projection_version,gate_overridden,created_at) VALUES(?,?,?,?,?,?)'
      ).run(randomId('PROMO'), input.intakeId, input.taskId, input.projectionVersion, input.gateOverridden ? 1 : 0, Date.now());

      const intake = getIntake(db, input.intakeId);
      if (intake && intake.state !== 'promoted') setIntakeState(db, input.intakeId, intake.revision, 'promoted');
      recordAudit(db, {
        kind: 'intake_promoted', actorKind: 'admin', intakeId: input.intakeId,
        detail: { taskId: input.taskId, projectionVersion: input.projectionVersion, gateOverridden: input.gateOverridden },
      });
    });
    insertAndPromote();
  } catch (e) {
    // Cross-process race: another promote for the same intake committed its
    // INSERT between our pre-check and this one, tripping UNIQUE(intake_id).
    // Treat it the same as the pre-check hit — idempotent, no throw.
    const raced = getPromotion(db, input.intakeId);
    if (raced) return { created: false, taskId: raced.task_id };
    throw e;
  }

  return { created: true, taskId: input.taskId };
}

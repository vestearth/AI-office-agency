import type { DB } from './db';
import { randomId } from './crypto';
import { getIntake, setIntakeState } from './intakeStore';
import { recordAudit } from './audit';
import { validateTriageResult } from './triageSchema';

export function importTriageResult(
  db: DB,
  input: {
    intakeId: string; expectedRevision: number; raw: unknown; importer: string;
    repoProvenance?: object; gateOverridden?: boolean;
  }
): { ok: true; state: string } | { ok: false; reason: 'not_found' | 'revision_conflict' | 'schema_invalid'; errors?: string[] } {
  const intake = getIntake(db, input.intakeId);
  if (!intake) return { ok: false, reason: 'not_found' };
  if (intake.revision !== input.expectedRevision) return { ok: false, reason: 'revision_conflict' };

  const validated = validateTriageResult(input.raw);
  if (!validated.ok) return { ok: false, reason: 'schema_invalid', errors: validated.errors };
  const result = validated.value;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO triage_result(id,intake_id,schema_version,result_json,importer,provider,context_hash,repo_provenance_json,gate_overridden,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).run(
      randomId('TRG'), input.intakeId, result.schemaVersion, JSON.stringify(result),
      input.importer, result.provider ?? null, result.contextHash,
      input.repoProvenance ? JSON.stringify(input.repoProvenance) : null,
      input.gateOverridden ? 1 : 0, Date.now()
    );
  });
  tx();
  // Transition state to the classification (revision was just checked; re-read for the bump).
  const fresh = getIntake(db, input.intakeId)!;
  setIntakeState(db, input.intakeId, fresh.revision, result.classification);
  recordAudit(db, {
    kind: 'triage_imported', actorKind: 'admin', actorId: input.importer, intakeId: input.intakeId,
    detail: { classification: result.classification, provider: result.provider, contextHash: result.contextHash, gateOverridden: !!input.gateOverridden },
  });
  return { ok: true, state: result.classification };
}

export function getLatestTriage(db: DB, intakeId: string): object | null {
  const row = db.prepare('SELECT result_json FROM triage_result WHERE intake_id = ? ORDER BY created_at DESC LIMIT 1').get(intakeId) as any;
  return row ? JSON.parse(row.result_json) : null;
}

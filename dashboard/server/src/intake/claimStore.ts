import type { DB } from './db';
import { randomId } from './crypto';
import { getIntake } from './intakeStore';
import { recordAudit } from './audit';

export interface ClaimRow {
  id: string; intake_id: string; owner: string; revision: number;
  created_at: number; expires_at: number; released_at: number | null;
}

export function getActiveClaim(db: DB, intakeId: string, now: number): ClaimRow | null {
  return (db.prepare(
    'SELECT * FROM claim WHERE intake_id = ? AND released_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1'
  ).get(intakeId, now) as ClaimRow) ?? null;
}

export function claimIntake(
  db: DB,
  input: { intakeId: string; owner: string; expectedRevision: number; now: number; ttlMs: number }
): { ok: true; claim: ClaimRow } | { ok: false; reason: 'not_found' | 'revision_conflict' | 'already_claimed' } {
  const intake = getIntake(db, input.intakeId);
  if (!intake) return { ok: false, reason: 'not_found' };
  if (intake.revision !== input.expectedRevision) return { ok: false, reason: 'revision_conflict' };
  if (getActiveClaim(db, input.intakeId, input.now)) return { ok: false, reason: 'already_claimed' };

  const claim: ClaimRow = {
    id: randomId('CLAIM'), intake_id: input.intakeId, owner: input.owner,
    revision: intake.revision, created_at: input.now, expires_at: input.now + input.ttlMs, released_at: null,
  };
  db.prepare(
    'INSERT INTO claim(id,intake_id,owner,revision,created_at,expires_at,released_at) VALUES(?,?,?,?,?,?,NULL)'
  ).run(claim.id, claim.intake_id, claim.owner, claim.revision, claim.created_at, claim.expires_at);
  recordAudit(db, { kind: 'intake_claimed', actorKind: 'admin', actorId: input.owner, intakeId: input.intakeId });
  return { ok: true, claim };
}

export function renewClaim(
  db: DB, input: { claimId: string; owner: string; now: number; ttlMs: number }
): { ok: boolean } {
  const row = db.prepare('SELECT * FROM claim WHERE id = ?').get(input.claimId) as ClaimRow | undefined;
  if (!row || row.owner !== input.owner || row.released_at != null) return { ok: false };
  db.prepare('UPDATE claim SET expires_at = ? WHERE id = ?').run(input.now + input.ttlMs, input.claimId);
  return { ok: true };
}

export function releaseClaim(db: DB, input: { claimId: string; owner: string }): { ok: boolean } {
  const row = db.prepare('SELECT * FROM claim WHERE id = ?').get(input.claimId) as ClaimRow | undefined;
  if (!row || row.owner !== input.owner || row.released_at != null) return { ok: false };
  db.prepare('UPDATE claim SET released_at = ? WHERE id = ?').run(Date.now(), input.claimId);
  recordAudit(db, { kind: 'intake_claim_released', actorKind: 'admin', actorId: input.owner, intakeId: row.intake_id });
  return { ok: true };
}

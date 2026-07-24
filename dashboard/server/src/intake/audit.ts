import type { DB } from './db';
import { randomId } from './crypto';

export interface AuditInput {
  kind: string;
  actorKind: 'tester' | 'admin' | 'system';
  actorId?: string;
  intakeId?: string;
  detail?: Record<string, unknown>;
}

export function recordAudit(db: DB, evt: AuditInput): void {
  db.prepare(
    `INSERT INTO audit_event(id, kind, actor_kind, actor_id, intake_id, detail_json, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomId('AUD'),
    evt.kind,
    evt.actorKind,
    evt.actorId ?? null,
    evt.intakeId ?? null,
    evt.detail ? JSON.stringify(evt.detail) : null,
    Date.now()
  );
}

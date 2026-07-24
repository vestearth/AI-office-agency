import type { DB } from './db';
import { hashSecret, verifySecret, randomId, randomToken } from './crypto';
import { recordAudit } from './audit';

export function provisionAdminCredential(
  db: DB, input: { label: string; capabilities: string[] }
): { id: string; secret: string } {
  const id = randomId('ADM');
  const secret = randomToken(24);
  const { hash, salt } = hashSecret(secret);
  db.prepare(
    'INSERT INTO admin_credential(id,label,cred_hash,salt,capabilities,created_at) VALUES(?,?,?,?,?,?)'
  ).run(id, input.label, hash, salt, JSON.stringify(input.capabilities), Date.now());
  recordAudit(db, { kind: 'admin_credential_provisioned', actorKind: 'admin', detail: { id, label: input.label, capabilities: input.capabilities } });
  return { id, secret };
}

export function verifyAdminSecret(
  db: DB, secret: string
): { ok: true; id: string; capabilities: string[] } | { ok: false } {
  const rows = db.prepare('SELECT id, cred_hash, salt, capabilities FROM admin_credential WHERE revoked_at IS NULL').all() as any[];
  for (const r of rows) {
    if (verifySecret(secret, r.cred_hash, r.salt)) {
      return { ok: true, id: r.id, capabilities: JSON.parse(r.capabilities) as string[] };
    }
  }
  return { ok: false };
}

export function listAdminCredentials(db: DB) {
  return db.prepare('SELECT id, label, capabilities, created_at, revoked_at FROM admin_credential').all();
}

export function revokeAdminCredential(db: DB, id: string): void {
  db.prepare('UPDATE admin_credential SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id);
  recordAudit(db, { kind: 'admin_credential_revoked', actorKind: 'admin', detail: { id } });
}

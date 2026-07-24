import type { DB } from './db';
import { hashSecret, verifySecret, randomId, randomToken } from './crypto';

export function issueAccessCode(db: DB, testerLabel: string): { testerId: string; code: string } {
  const testerId = randomId('TSTR');
  const code = randomToken(16); // 32 hex chars — large code space (Decision #2)
  const { hash, salt } = hashSecret(code);
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO tester(id, label, created_at) VALUES(?, ?, ?)').run(testerId, testerLabel, now);
    db.prepare(
      'INSERT INTO access_code(id, tester_id, code_hash, salt, created_at) VALUES(?, ?, ?, ?, ?)'
    ).run(randomId('CODE'), testerId, hash, salt, now);
  });
  tx();
  return { testerId, code };
}

export function verifyAccessCode(db: DB, code: string): { ok: true; testerId: string } | { ok: false } {
  const rows = db
    .prepare('SELECT tester_id, code_hash, salt FROM access_code WHERE revoked_at IS NULL')
    .all() as { tester_id: string; code_hash: string; salt: string }[];
  for (const r of rows) {
    if (verifySecret(code, r.code_hash, r.salt)) {
      const tester = db.prepare('SELECT revoked_at FROM tester WHERE id = ?').get(r.tester_id) as any;
      if (tester && tester.revoked_at == null) return { ok: true, testerId: r.tester_id };
    }
  }
  return { ok: false };
}

export function revokeAccessCode(db: DB, testerId: string): void {
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare('UPDATE access_code SET revoked_at = ? WHERE tester_id = ? AND revoked_at IS NULL').run(now, testerId);
    db.prepare('UPDATE tester SET revoked_at = ? WHERE id = ?').run(now, testerId);
  });
  tx();
}

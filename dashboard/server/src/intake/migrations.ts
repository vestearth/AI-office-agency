import type { DB } from './db';

// Each migration is idempotent (IF NOT EXISTS) so boot can replay all of them
// safely — mirrors the Games-Labs boot-time-migration invariant.
const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tester (
        id TEXT PRIMARY KEY, label TEXT NOT NULL,
        created_at INTEGER NOT NULL, revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS access_code (
        id TEXT PRIMARY KEY, tester_id TEXT NOT NULL REFERENCES tester(id),
        code_hash TEXT NOT NULL, salt TEXT NOT NULL,
        created_at INTEGER NOT NULL, revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY, tester_id TEXT NOT NULL REFERENCES tester(id),
        csrf_token TEXT NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS intake (
        id TEXT PRIMARY KEY, tester_id TEXT NOT NULL REFERENCES tester(id),
        title TEXT NOT NULL, body TEXT NOT NULL, product_hint TEXT,
        state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        idempotency_key TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(tester_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS attachment (
        id TEXT PRIMARY KEY, intake_id TEXT NOT NULL REFERENCES intake(id),
        stored_name TEXT NOT NULL, original_name TEXT NOT NULL, mime TEXT NOT NULL,
        byte_size INTEGER NOT NULL, content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL, deleted_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS audit_event (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, actor_kind TEXT NOT NULL,
        actor_id TEXT, intake_id TEXT, detail_json TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_credential (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, cred_hash TEXT NOT NULL,
        salt TEXT NOT NULL, capabilities TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_intake_state ON intake(state, updated_at);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_event(created_at);
    `,
  },
];

export function runMigrations(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);');
  const applied = new Set(
    db.prepare('SELECT version FROM schema_version').all().map((r: any) => r.version)
  );
  const tx = db.transaction((m: { version: number; sql: string }) => {
    db.exec(m.sql);
    db.prepare('INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES(?, ?)').run(
      m.version,
      Date.now()
    );
  });
  for (const m of MIGRATIONS) {
    if (!applied.has(m.version)) tx(m);
  }
}

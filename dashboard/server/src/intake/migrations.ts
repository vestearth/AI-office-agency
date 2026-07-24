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
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS change_counter (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL);
      INSERT OR IGNORE INTO change_counter(id, seq) VALUES (1, 0);
      CREATE INDEX IF NOT EXISTS idx_intake_change_seq ON intake(change_seq);
      CREATE TABLE IF NOT EXISTS claim (
        id TEXT PRIMARY KEY, intake_id TEXT NOT NULL REFERENCES intake(id),
        owner TEXT NOT NULL, revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, released_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_claim_intake ON claim(intake_id);
      CREATE TABLE IF NOT EXISTS triage_result (
        id TEXT PRIMARY KEY, intake_id TEXT NOT NULL REFERENCES intake(id),
        schema_version TEXT NOT NULL, result_json TEXT NOT NULL,
        importer TEXT NOT NULL, provider TEXT, context_hash TEXT,
        repo_provenance_json TEXT, gate_overridden INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_triage_intake ON triage_result(intake_id);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS promotion (
        id TEXT PRIMARY KEY, intake_id TEXT NOT NULL UNIQUE REFERENCES intake(id),
        task_id TEXT NOT NULL, projection_version TEXT NOT NULL,
        gate_overridden INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
    `,
  },
  {
    // Adds revoked_at to admin_credential (v1 table had no revocation column).
    // The actual ALTER runs via addColumnIfMissing in the version===4 branch
    // below — this sql is a no-op placeholder so schema_version bookkeeping
    // stays consistent with the other versions.
    version: 4,
    sql: `SELECT 1;`,
  },
];

// SQLite has no "ADD COLUMN IF NOT EXISTS" — boot replays ALL migrations every
// startup, so a raw ALTER in the versioned `sql` above would throw "duplicate
// column name" on the second boot. Guard it with a PRAGMA table_info check.
function addColumnIfMissing(db: DB, table: string, column: string, decl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

export function runMigrations(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);');
  const applied = new Set(
    db.prepare('SELECT version FROM schema_version').all().map((r: any) => r.version)
  );
  const tx = db.transaction((m: { version: number; sql: string }) => {
    if (m.version === 2) {
      addColumnIfMissing(db, 'intake', 'change_seq', 'INTEGER NOT NULL DEFAULT 0');
    }
    if (m.version === 4) {
      addColumnIfMissing(db, 'admin_credential', 'revoked_at', 'INTEGER');
    }
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

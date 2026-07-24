# AI Dev Office Intake Board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Central foundation of a pre-TASK Intake Board — a LAN-facing tester surface where authenticated testers submit bug/work-request intakes with attachments, backed by a single-writer SQLite store, with all locked security guardrails (access-code auth, CSRF, throttling, storage caps) in place.

**Architecture:** Extend the existing `ai-dev-office/dashboard` Express/TypeScript backend as the single writer of a new SQLite database (source of truth for tester identities, sessions, intakes, attachments, idempotency, and audit). Tester-facing intake routes use their own session-cookie auth (independent of the existing shared bearer token) and mount on a separate router tree. The autonomous runner (`run-agent.sh`) is never invoked from this surface, and no `runs/` write path exists in Milestone 1.

**Tech Stack:** Node.js + Express 4 + TypeScript, `better-sqlite3` (synchronous single-writer, WAL mode), Node built-in `crypto` (scrypt for code/credential hashing, randomBytes for tokens), `file-type` for content-sniff MIME validation, existing `js-yaml`. Tests: Node's built-in test runner (`node --require ts-node/register --test`).

## Global Constraints

- **Repo scope:** All changes live under `ai-dev-office/dashboard/`. This is a meta/tooling repo edit — **no `TASK-` run is required** (per `ai-dev-office/docs/CLAUDE.md` meta-repo exception). Do not create a TASK, do not touch `status.yaml`, do not modify `knowledge-base/`.
- **Single writer:** The Central Express backend is the *only* process that writes the Intake SQLite DB (Human-Locked Decision #4). No second writer, no direct file access from the Local machine.
- **No `runs/` write in M1:** Milestone 1 has zero code path that writes `runs/`, invokes `run-agent.sh`, or touches the role/phase enums. Promotion is Milestone 2.
- **Auth is backend-enforced:** Authorization is by server-verified session capability, never by URL, tab, Host header, or client visibility (Decision #1).
- **Access codes stored as hashes only:** Never persist a raw access code; never place a code in a URL/query/localStorage (Decisions #2, #3).
- **No state-changing GET:** Every mutation is POST/PUT/DELETE and must pass CSRF checks (Decision #3).
- **Node test runner only:** Match existing pattern — `node --require ts-node/register --test "src/**/*.test.ts"`. Do not add jest/vitest.
- **Config-driven paths:** All data/attachment/backup locations come from env (`INTAKE_DATA_DIR`, `INTAKE_ATTACHMENT_DIR`, `INTAKE_BACKUP_TARGET`), mirroring the existing `config.ts` pattern (Decision #13).
- **Worktree caveat:** If executing in a git worktree, verify `pwd`/branch before every commit. Commit snippets below use paths relative to the `ai-dev-office/` repo root — do not prepend an absolute `cd` to a stale checkout (see knowledge memory `sdd-worktree-plan-drift`).
- **Assumptions labeled `[PLAN-ASSUMPTION]`** are choices this plan makes that go beyond the locked spec; the owner may override any of them without reopening a locked decision.

---

## Scope Note

The full MVP is the fourteen human-locked decisions across three delivery milestones (see handoff `MVP Delivery Sequencing`). This document plans **Milestone 1 (Central foundation)** to executable bite-sized granularity — it produces a working, testable tester-facing intake service on its own. **Milestones 2 (Local workflow) and 3 (LAN-release hardening)** are given task-level outlines at the end and must each get their own detailed plan before execution. Do not begin M2/M3 from the outline alone.

---

## File Structure (Milestone 1)

New files under `dashboard/server/src/`:

- `intake/db.ts` — SQLite connection bootstrap (WAL, foreign keys), singleton handle.
- `intake/migrations.ts` — ordered, idempotent schema migrations + `schema_version` table.
- `intake/config.ts` — intake-specific config (data dir, attachment dir, caps, TTLs) read from env.
- `intake/crypto.ts` — scrypt hash/verify for access codes + admin credential; random token/id generators.
- `intake/accessCodeStore.ts` — issue/verify/revoke access codes; identity lookup by verified code.
- `intake/sessionStore.ts` — create/lookup/expire sessions; CSRF token per session.
- `intake/intakeStore.ts` — insert/list/get intakes; revision; append-only audit; idempotency keys.
- `intake/attachmentStore.ts` — validate + store attachment bytes under randomized names; metadata rows.
- `intake/rateLimiter.ts` — configurable window/backoff counters for code-exchange + submission caps.
- `intake/audit.ts` — server-derived audit event writer (never trusts client actor/time).
- `middleware/testerSession.ts` — resolve session cookie → tester identity; reject if absent/expired.
- `middleware/csrf.ts` — enforce Origin/Referer + Fetch-Metadata + `X-CSRF-Token` on unsafe methods.
- `routes/intake/auth.ts` — `POST /api/intake/session` (code exchange), `DELETE /api/intake/session` (logout).
- `routes/intake/intakes.ts` — `POST/GET /api/intake/intakes`, `GET /api/intake/intakes/:id`.
- `routes/intake/attachments.ts` — `POST /api/intake/intakes/:id/attachments`, `GET .../:attId`.
- `routes/intake/admin.ts` — admin-only: issue/revoke codes, list throttled sessions, delete attachment.

Modified:

- `dashboard/server/package.json` — add `better-sqlite3`, `file-type`, and `@types/better-sqlite3`.
- `dashboard/server/src/config.ts` — no change (intake config is separate); referenced only.
- `dashboard/server/src/index.ts:26-36` — mount the intake router tree **before** the shared-bearer `/api` guard so tester routes use session auth, not the bearer token.
- `dashboard/server/.env.example` — document new `INTAKE_*` env vars.

---

## Task 1: Add dependencies and intake config

**Files:**
- Modify: `dashboard/server/package.json`
- Create: `dashboard/server/src/intake/config.ts`
- Create: `dashboard/server/src/intake/config.test.ts`
- Modify: `dashboard/server/.env.example`

**Interfaces:**
- Produces: `intakeConfig` object with `{ dataDir, attachmentDir, backupTarget, dbPath, sessionTtlMs, codeExchange: { windowMs, maxAttempts, backoffBaseMs }, submission: { windowMs, maxPerWindow, maxUploadBytesPerWindow }, attachment: { maxBytes, maxPerIntake, maxAggregateBytesPerIntake, allowedMime }, storageHighWaterBytes }`.

- [ ] **Step 1: Add deps**

In `dashboard/server/package.json`, add to `dependencies`: `"better-sqlite3": "^11.0.0"`, `"file-type": "^16.5.4"` (v16 is CommonJS-friendly under ts-node; `[PLAN-ASSUMPTION]`). Add to `devDependencies`: `"@types/better-sqlite3": "^7.6.0"`. Then run:

```bash
cd dashboard/server && npm install
```
Expected: installs without error; `node -e "require('better-sqlite3')"` prints nothing (no throw).

- [ ] **Step 2: Write the failing test**

```typescript
// dashboard/server/src/intake/config.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { loadIntakeConfig } from './config';

test('loadIntakeConfig derives dbPath under dataDir and applies caps', () => {
  const cfg = loadIntakeConfig({
    INTAKE_DATA_DIR: '/tmp/intake-data',
    INTAKE_ATTACHMENT_DIR: '',
    INTAKE_ATTACHMENT_MAX_BYTES: '5242880',
  });
  assert.equal(cfg.dbPath, path.join('/tmp/intake-data', 'intake.sqlite'));
  // Attachment dir defaults under dataDir when unset.
  assert.equal(cfg.attachmentDir, path.join('/tmp/intake-data', 'attachments'));
  assert.equal(cfg.attachment.maxBytes, 5_242_880);
  assert.ok(cfg.attachment.allowedMime.includes('image/png'));
  assert.ok(!cfg.attachment.allowedMime.includes('application/zip'));
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/config.test.ts`
Expected: FAIL with "Cannot find module './config'".

- [ ] **Step 4: Write minimal implementation**

```typescript
// dashboard/server/src/intake/config.ts
import path from 'path';

export interface IntakeConfig {
  dataDir: string;
  attachmentDir: string;
  backupTarget: string;
  dbPath: string;
  sessionTtlMs: number;
  codeExchange: { windowMs: number; maxAttempts: number; backoffBaseMs: number };
  submission: { windowMs: number; maxPerWindow: number; maxUploadBytesPerWindow: number };
  attachment: {
    maxBytes: number;
    maxPerIntake: number;
    maxAggregateBytesPerIntake: number;
    allowedMime: string[];
  };
  storageHighWaterBytes: number;
}

const int = (v: string | undefined, def: number) => {
  const n = parseInt((v ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

// Decision #7: PNG/JPEG/WebP/TXT/LOG only; reject archives/executables/video.
const DEFAULT_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'text/plain'];

export function loadIntakeConfig(env: NodeJS.ProcessEnv = process.env): IntakeConfig {
  const dataDir = (env.INTAKE_DATA_DIR || path.resolve(process.cwd(), 'intake-data')).trim();
  const attachmentDir = (env.INTAKE_ATTACHMENT_DIR || '').trim() || path.join(dataDir, 'attachments');
  return {
    dataDir,
    attachmentDir,
    backupTarget: (env.INTAKE_BACKUP_TARGET || path.join(dataDir, 'backups')).trim(),
    dbPath: path.join(dataDir, 'intake.sqlite'),
    sessionTtlMs: int(env.INTAKE_SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000), // 7 days (Decision #7)
    codeExchange: {
      windowMs: int(env.INTAKE_CODE_WINDOW_MS, 15 * 60 * 1000),
      maxAttempts: int(env.INTAKE_CODE_MAX_ATTEMPTS, 10),
      backoffBaseMs: int(env.INTAKE_CODE_BACKOFF_BASE_MS, 500),
    },
    submission: {
      windowMs: int(env.INTAKE_SUBMIT_WINDOW_MS, 60 * 60 * 1000),
      maxPerWindow: int(env.INTAKE_SUBMIT_MAX_PER_WINDOW, 20),
      maxUploadBytesPerWindow: int(env.INTAKE_SUBMIT_MAX_UPLOAD_BYTES, 50 * 1024 * 1024),
    },
    attachment: {
      maxBytes: int(env.INTAKE_ATTACHMENT_MAX_BYTES, 5 * 1024 * 1024),
      maxPerIntake: int(env.INTAKE_ATTACHMENT_MAX_PER_INTAKE, 10),
      maxAggregateBytesPerIntake: int(env.INTAKE_ATTACHMENT_MAX_AGGREGATE_BYTES, 20 * 1024 * 1024),
      allowedMime: DEFAULT_ALLOWED_MIME,
    },
    storageHighWaterBytes: int(env.INTAKE_STORAGE_HIGH_WATER_BYTES, 5 * 1024 * 1024 * 1024),
  };
}

export const intakeConfig = loadIntakeConfig();
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Document env + commit**

Append to `dashboard/server/.env.example`:

```bash
# --- Intake Board (Central) ---
INTAKE_DATA_DIR=./intake-data
INTAKE_ATTACHMENT_DIR=
INTAKE_BACKUP_TARGET=
INTAKE_SESSION_TTL_MS=604800000
INTAKE_CODE_MAX_ATTEMPTS=10
INTAKE_CODE_WINDOW_MS=900000
INTAKE_SUBMIT_MAX_PER_WINDOW=20
INTAKE_ATTACHMENT_MAX_BYTES=5242880
INTAKE_ATTACHMENT_MAX_PER_INTAKE=10
INTAKE_STORAGE_HIGH_WATER_BYTES=5368709120
```

```bash
git add dashboard/server/package.json dashboard/server/package-lock.json dashboard/server/src/intake/config.ts dashboard/server/src/intake/config.test.ts dashboard/server/.env.example
git commit -m "feat(intake): add SQLite deps and intake config"
```

---

## Task 2: SQLite bootstrap + idempotent migrations

**Files:**
- Create: `dashboard/server/src/intake/db.ts`
- Create: `dashboard/server/src/intake/migrations.ts`
- Create: `dashboard/server/src/intake/migrations.test.ts`

**Interfaces:**
- Consumes: `intakeConfig.dbPath` from Task 1.
- Produces: `openDb(dbPath: string): Database` (better-sqlite3 handle, WAL + foreign_keys on); `runMigrations(db: Database): void` (idempotent, re-runnable every boot per knowledge memory `boot-time-migration-idempotency`); `getDb(): Database` singleton.
- Schema tables produced (relied on by later tasks): `schema_version`, `tester(id, label, created_at, revoked_at)`, `access_code(id, tester_id, code_hash, salt, created_at, revoked_at)`, `session(id, tester_id, csrf_token, created_at, expires_at, revoked_at)`, `intake(id, tester_id, title, body, product_hint, state, revision, idempotency_key, created_at, updated_at)`, `attachment(id, intake_id, stored_name, original_name, mime, byte_size, content_hash, created_at, deleted_at)`, `audit_event(id, kind, actor_kind, actor_id, intake_id, detail_json, created_at)`, `admin_credential(id, label, cred_hash, salt, capabilities, created_at)`.

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/server/src/intake/migrations.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';

test('runMigrations is idempotent and creates core tables', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  runMigrations(db); // second run must not throw (boot replays all migrations)
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r: any) => r.name);
  for (const t of ['access_code', 'attachment', 'audit_event', 'intake', 'session', 'tester']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  const ver = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as any;
  assert.ok(ver.v >= 1);
});

test('intake enforces unique idempotency_key per tester', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO tester(id,label,created_at) VALUES('t1','T',1)").run();
  const ins = db.prepare(
    "INSERT INTO intake(id,tester_id,title,body,state,revision,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)"
  );
  ins.run('i1', 't1', 'a', 'b', 'submitted', 1, 'key-1', 1, 1);
  assert.throws(() => ins.run('i2', 't1', 'a', 'b', 'submitted', 1, 'key-1', 1, 1));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/migrations.test.ts`
Expected: FAIL with "Cannot find module './db'".

- [ ] **Step 3: Write `db.ts`**

```typescript
// dashboard/server/src/intake/db.ts
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { intakeConfig } from './config';
import { runMigrations } from './migrations';

export type DB = Database.Database;

export function openDb(dbPath: string): DB {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); // Decision #13: WAL-consistent backups later
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  return db;
}

let singleton: DB | null = null;
export function getDb(): DB {
  if (!singleton) {
    singleton = openDb(intakeConfig.dbPath);
    runMigrations(singleton);
  }
  return singleton;
}
```

- [ ] **Step 4: Write `migrations.ts`**

```typescript
// dashboard/server/src/intake/migrations.ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/migrations.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add dashboard/server/src/intake/db.ts dashboard/server/src/intake/migrations.ts dashboard/server/src/intake/migrations.test.ts
git commit -m "feat(intake): SQLite bootstrap and idempotent migrations"
```

---

## Task 3: Crypto helpers (scrypt hash/verify, random ids/tokens)

**Files:**
- Create: `dashboard/server/src/intake/crypto.ts`
- Create: `dashboard/server/src/intake/crypto.test.ts`

**Interfaces:**
- Produces: `hashSecret(secret: string): { hash: string; salt: string }`; `verifySecret(secret: string, hash: string, salt: string): boolean` (constant-time); `randomId(prefix: string): string`; `randomToken(bytes?: number): string`.

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/server/src/intake/crypto.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashSecret, verifySecret, randomId, randomToken } from './crypto';

test('hash/verify round-trips and rejects wrong secret', () => {
  const { hash, salt } = hashSecret('correct horse');
  assert.equal(verifySecret('correct horse', hash, salt), true);
  assert.equal(verifySecret('wrong', hash, salt), false);
});

test('randomId is prefixed and unique; randomToken is hex', () => {
  const a = randomId('INTAKE');
  const b = randomId('INTAKE');
  assert.ok(a.startsWith('INTAKE-'));
  assert.notEqual(a, b);
  assert.match(randomToken(16), /^[0-9a-f]{32}$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/crypto.test.ts`
Expected: FAIL with "Cannot find module './crypto'".

- [ ] **Step 3: Write implementation**

```typescript
// dashboard/server/src/intake/crypto.ts
import crypto from 'crypto';

const KEYLEN = 64;

export function hashSecret(secret: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(secret, salt, KEYLEN).toString('hex');
  return { hash, salt };
}

export function verifySecret(secret: string, hash: string, salt: string): boolean {
  const derived = crypto.scryptSync(secret, salt, KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(9).toString('hex')}`;
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/crypto.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/server/src/intake/crypto.ts dashboard/server/src/intake/crypto.test.ts
git commit -m "feat(intake): scrypt hashing and random id/token helpers"
```

---

## Task 4: Audit writer (server-derived only)

**Files:**
- Create: `dashboard/server/src/intake/audit.ts`
- Create: `dashboard/server/src/intake/audit.test.ts`

**Interfaces:**
- Consumes: `getDb()` (Task 2), `randomId` (Task 3).
- Produces: `recordAudit(db, evt: { kind: string; actorKind: 'tester'|'admin'|'system'; actorId?: string; intakeId?: string; detail?: object }): void`. Timestamp is always server `Date.now()`; caller-supplied time/actor-name is never trusted (mirrors `decisionStore` server-derived audit).

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/server/src/intake/audit.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { recordAudit } from './audit';

test('recordAudit stamps server time and stores detail json', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  recordAudit(db, { kind: 'code_exchange_failed', actorKind: 'system', detail: { reason: 'x' } });
  const row = db.prepare('SELECT * FROM audit_event').get() as any;
  assert.equal(row.kind, 'code_exchange_failed');
  assert.equal(row.actor_kind, 'system');
  assert.ok(row.created_at > 0);
  assert.deepEqual(JSON.parse(row.detail_json), { reason: 'x' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/audit.test.ts`
Expected: FAIL with "Cannot find module './audit'".

- [ ] **Step 3: Write implementation**

```typescript
// dashboard/server/src/intake/audit.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/audit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/server/src/intake/audit.ts dashboard/server/src/intake/audit.test.ts
git commit -m "feat(intake): server-derived audit event writer"
```

---

## Task 5: Access-code store (issue / verify / revoke)

**Files:**
- Create: `dashboard/server/src/intake/accessCodeStore.ts`
- Create: `dashboard/server/src/intake/accessCodeStore.test.ts`

**Interfaces:**
- Consumes: `getDb`, `hashSecret`/`verifySecret`/`randomId`/`randomToken`, `recordAudit`.
- Produces:
  - `issueAccessCode(db, testerLabel: string): { testerId: string; code: string }` — creates tester + code row; returns the **raw code once** (never stored raw).
  - `verifyAccessCode(db, code: string): { ok: true; testerId: string } | { ok: false }` — looks up by scanning non-revoked codes (constant-time verify per row); returns tester on match.
  - `revokeAccessCode(db, testerId: string): void`.

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/server/src/intake/accessCodeStore.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { issueAccessCode, verifyAccessCode, revokeAccessCode } from './accessCodeStore';

test('issued code verifies to its tester and raw code is never stored', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  const { testerId, code } = issueAccessCode(db, 'QA Tester A');
  const stored = db.prepare('SELECT code_hash FROM access_code').get() as any;
  assert.notEqual(stored.code_hash, code); // stored as hash, not raw
  const res = verifyAccessCode(db, code);
  assert.deepEqual(res, { ok: true, testerId });
});

test('wrong and revoked codes do not verify', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  const { testerId, code } = issueAccessCode(db, 'QA Tester B');
  assert.deepEqual(verifyAccessCode(db, 'not-a-code'), { ok: false });
  revokeAccessCode(db, testerId);
  assert.deepEqual(verifyAccessCode(db, code), { ok: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/accessCodeStore.test.ts`
Expected: FAIL with "Cannot find module './accessCodeStore'".

- [ ] **Step 3: Write implementation**

```typescript
// dashboard/server/src/intake/accessCodeStore.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/accessCodeStore.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add dashboard/server/src/intake/accessCodeStore.ts dashboard/server/src/intake/accessCodeStore.test.ts
git commit -m "feat(intake): access-code issue/verify/revoke store"
```

---

## Task 6: Rate limiter (code-exchange + submission windows)

**Files:**
- Create: `dashboard/server/src/intake/rateLimiter.ts`
- Create: `dashboard/server/src/intake/rateLimiter.test.ts`

**Interfaces:**
- Produces: `class WindowLimiter` with `hit(key: string, now: number): { allowed: boolean; retryAfterMs: number; attempts: number }` and `reset(key)`; constructed with `{ windowMs, maxAttempts, backoffBaseMs? }`. In-memory fixed-window with progressive backoff on over-limit `[PLAN-ASSUMPTION]` (single-host M1; persistence not required, but failed attempts are audited by the caller). Also `class ByteBudget` with `charge(key, bytes, now)` for upload-byte-per-window caps.

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/server/src/intake/rateLimiter.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WindowLimiter } from './rateLimiter';

test('allows up to maxAttempts then blocks with backoff, resets after window', () => {
  const lim = new WindowLimiter({ windowMs: 1000, maxAttempts: 3, backoffBaseMs: 100 });
  let now = 0;
  assert.equal(lim.hit('ip1', now).allowed, true);
  assert.equal(lim.hit('ip1', now).allowed, true);
  assert.equal(lim.hit('ip1', now).allowed, true);
  const blocked = lim.hit('ip1', now);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  // Different key is unaffected.
  assert.equal(lim.hit('ip2', now).allowed, true);
  // After the window elapses, the key is allowed again.
  now += 1001;
  assert.equal(lim.hit('ip1', now).allowed, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/rateLimiter.test.ts`
Expected: FAIL with "Cannot find module './rateLimiter'".

- [ ] **Step 3: Write implementation**

```typescript
// dashboard/server/src/intake/rateLimiter.ts
interface Bucket { windowStart: number; count: number; }

export class WindowLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private opts: { windowMs: number; maxAttempts: number; backoffBaseMs?: number }) {}

  hit(key: string, now: number): { allowed: boolean; retryAfterMs: number; attempts: number } {
    let b = this.buckets.get(key);
    if (!b || now - b.windowStart >= this.opts.windowMs) {
      b = { windowStart: now, count: 0 };
      this.buckets.set(key, b);
    }
    b.count += 1;
    if (b.count <= this.opts.maxAttempts) {
      return { allowed: true, retryAfterMs: 0, attempts: b.count };
    }
    const over = b.count - this.opts.maxAttempts;
    const base = this.opts.backoffBaseMs ?? 0;
    const remainingWindow = this.opts.windowMs - (now - b.windowStart);
    const retryAfterMs = Math.max(remainingWindow, base * over); // progressive backoff
    return { allowed: false, retryAfterMs, attempts: b.count };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }
}

export class ByteBudget {
  private used = new Map<string, { windowStart: number; bytes: number }>();
  constructor(private opts: { windowMs: number; maxBytes: number }) {}

  charge(key: string, bytes: number, now: number): { allowed: boolean; retryAfterMs: number } {
    let u = this.used.get(key);
    if (!u || now - u.windowStart >= this.opts.windowMs) {
      u = { windowStart: now, bytes: 0 };
      this.used.set(key, u);
    }
    if (u.bytes + bytes > this.opts.maxBytes) {
      return { allowed: false, retryAfterMs: this.opts.windowMs - (now - u.windowStart) };
    }
    u.bytes += bytes;
    return { allowed: true, retryAfterMs: 0 };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/rateLimiter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/server/src/intake/rateLimiter.ts dashboard/server/src/intake/rateLimiter.test.ts
git commit -m "feat(intake): window + byte-budget rate limiters"
```

---

## Task 7: Session store + tester-session middleware

**Files:**
- Create: `dashboard/server/src/intake/sessionStore.ts`
- Create: `dashboard/server/src/intake/sessionStore.test.ts`
- Create: `dashboard/server/src/middleware/testerSession.ts`
- Create: `dashboard/server/src/middleware/testerSession.test.ts`

**Interfaces:**
- Consumes: `getDb`, `randomId`/`randomToken`, `intakeConfig.sessionTtlMs`.
- Produces:
  - `createSession(db, testerId, now): { sessionId: string; csrfToken: string; expiresAt: number }`.
  - `getValidSession(db, sessionId, now): { testerId: string; csrfToken: string } | null` (null if missing/expired/revoked).
  - `revokeSession(db, sessionId): void`.
  - Middleware `requireTesterSession(req,res,next)` reading cookie `intake_sid`; sets `req.tester = { id, sessionId, csrfToken }`; returns 401 otherwise.

- [ ] **Step 1: Write the failing tests**

```typescript
// dashboard/server/src/intake/sessionStore.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { createSession, getValidSession, revokeSession } from './sessionStore';

test('created session validates until expiry, then not', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO tester(id,label,created_at) VALUES('t1','T',1)").run();
  const now = 1000;
  const s = createSession(db, 't1', now, 500); // ttl 500ms
  const ok = getValidSession(db, s.sessionId, now + 100);
  assert.equal(ok?.testerId, 't1');
  assert.equal(getValidSession(db, s.sessionId, now + 600), null); // expired
});

test('revoked session no longer validates', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO tester(id,label,created_at) VALUES('t1','T',1)").run();
  const s = createSession(db, 't1', 0, 10_000);
  revokeSession(db, s.sessionId);
  assert.equal(getValidSession(db, s.sessionId, 1), null);
});
```

```typescript
// dashboard/server/src/middleware/testerSession.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../intake/db';
import { runMigrations } from '../intake/migrations';
import { createSession } from '../intake/sessionStore';
import { makeRequireTesterSession } from './testerSession';

function res() {
  return { statusCode: 0, body: null as any,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; } };
}

test('rejects missing cookie with 401, accepts valid session', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO tester(id,label,created_at) VALUES('t1','T',1)").run();
  const s = createSession(db, 't1', Date.now(), 10_000);
  const mw = makeRequireTesterSession(() => db);

  const r1 = res(); let n1 = false;
  mw({ cookies: {} } as any, r1 as any, () => { n1 = true; });
  assert.equal(r1.statusCode, 401);
  assert.equal(n1, false);

  const req2: any = { cookies: { intake_sid: s.sessionId } };
  const r2 = res(); let n2 = false;
  mw(req2, r2 as any, () => { n2 = true; });
  assert.equal(n2, true);
  assert.equal(req2.tester.id, 't1');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/sessionStore.test.ts src/middleware/testerSession.test.ts`
Expected: FAIL with missing modules.

- [ ] **Step 3: Write `sessionStore.ts`**

```typescript
// dashboard/server/src/intake/sessionStore.ts
import type { DB } from './db';
import { randomId, randomToken } from './crypto';
import { intakeConfig } from './config';

export function createSession(
  db: DB, testerId: string, now: number, ttlMs = intakeConfig.sessionTtlMs
): { sessionId: string; csrfToken: string; expiresAt: number } {
  const sessionId = randomToken(32);
  const csrfToken = randomToken(32);
  const expiresAt = now + ttlMs;
  db.prepare(
    'INSERT INTO session(id, tester_id, csrf_token, created_at, expires_at) VALUES(?, ?, ?, ?, ?)'
  ).run(sessionId, testerId, csrfToken, now, expiresAt);
  return { sessionId, csrfToken, expiresAt };
}

export function getValidSession(
  db: DB, sessionId: string, now: number
): { testerId: string; csrfToken: string } | null {
  const row = db
    .prepare('SELECT tester_id, csrf_token, expires_at, revoked_at FROM session WHERE id = ?')
    .get(sessionId) as any;
  if (!row || row.revoked_at != null || row.expires_at <= now) return null;
  return { testerId: row.tester_id, csrfToken: row.csrf_token };
}

export function revokeSession(db: DB, sessionId: string): void {
  db.prepare('UPDATE session SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), sessionId);
}
```

- [ ] **Step 4: Write `testerSession.ts`**

```typescript
// dashboard/server/src/middleware/testerSession.ts
import type { Request, Response, NextFunction } from 'express';
import type { DB } from '../intake/db';
import { getDb } from '../intake/db';
import { getValidSession } from '../intake/sessionStore';

export interface TesterContext { id: string; sessionId: string; csrfToken: string; }
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { tester?: TesterContext; } }
}

// Cookie parsing is minimal here to avoid a new dependency; index.ts adds a
// tiny cookie parser (Task 11) so req.cookies is populated.
export function makeRequireTesterSession(dbFn: () => DB) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const sid = (req as any).cookies?.intake_sid;
    if (!sid || typeof sid !== 'string') {
      res.status(401).json({ error: 'No session' });
      return;
    }
    const session = getValidSession(dbFn(), sid, Date.now());
    if (!session) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }
    req.tester = { id: session.testerId, sessionId: sid, csrfToken: session.csrfToken };
    next();
  };
}

export const requireTesterSession = makeRequireTesterSession(getDb);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/sessionStore.test.ts src/middleware/testerSession.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/server/src/intake/sessionStore.ts dashboard/server/src/intake/sessionStore.test.ts dashboard/server/src/middleware/testerSession.ts dashboard/server/src/middleware/testerSession.test.ts
git commit -m "feat(intake): SQLite session store and tester-session middleware"
```

---

## Task 8: CSRF middleware

**Files:**
- Create: `dashboard/server/src/middleware/csrf.ts`
- Create: `dashboard/server/src/middleware/csrf.test.ts`

**Interfaces:**
- Consumes: `req.tester.csrfToken` (Task 7).
- Produces: `makeCsrfGuard({ allowedOrigins })` middleware enforcing, for unsafe methods (POST/PUT/PATCH/DELETE): (a) `Origin` (or `Referer`) present and in `allowedOrigins`; (b) `Sec-Fetch-Site` is `same-origin`/`same-site`/`none` when the header exists; (c) `X-CSRF-Token` header equals the session's `csrfToken` (constant-time). Safe methods pass through (Decision #3: no state-changing GET, so GETs need no CSRF token).

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/server/src/middleware/csrf.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCsrfGuard } from './csrf';

function res() {
  return { statusCode: 0, body: null as any,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; } };
}
const guard = makeCsrfGuard({ allowedOrigins: ['https://intake.lan'] });

test('GET passes without token', () => {
  let n = false;
  guard({ method: 'GET', headers: {}, tester: { csrfToken: 't' } } as any, res() as any, () => { n = true; });
  assert.equal(n, true);
});

test('POST rejects bad origin, bad token, and passes when both valid', () => {
  const base = { method: 'POST', tester: { csrfToken: 'good-token' } };
  // bad origin
  const r1 = res(); let n1 = false;
  guard({ ...base, headers: { origin: 'https://evil.lan', 'x-csrf-token': 'good-token' } } as any, r1 as any, () => { n1 = true; });
  assert.equal(r1.statusCode, 403); assert.equal(n1, false);
  // good origin, bad token
  const r2 = res(); let n2 = false;
  guard({ ...base, headers: { origin: 'https://intake.lan', 'x-csrf-token': 'wrong' } } as any, r2 as any, () => { n2 = true; });
  assert.equal(r2.statusCode, 403); assert.equal(n2, false);
  // good origin, good token, good fetch-site
  const r3 = res(); let n3 = false;
  guard({ ...base, headers: { origin: 'https://intake.lan', 'x-csrf-token': 'good-token', 'sec-fetch-site': 'same-origin' } } as any, r3 as any, () => { n3 = true; });
  assert.equal(n3, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/server && node --require ts-node/register --test src/middleware/csrf.test.ts`
Expected: FAIL with "Cannot find module './csrf'".

- [ ] **Step 3: Write implementation**

```typescript
// dashboard/server/src/middleware/csrf.ts
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const OK_FETCH_SITE = new Set(['same-origin', 'same-site', 'none']);

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function originOf(req: Request): string | null {
  const o = req.headers.origin;
  if (typeof o === 'string' && o) return o;
  const ref = req.headers.referer;
  if (typeof ref === 'string' && ref) {
    try { return new URL(ref).origin; } catch { return null; }
  }
  return null;
}

export function makeCsrfGuard(opts: { allowedOrigins: string[] }) {
  const allowed = new Set(opts.allowedOrigins);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE.has(req.method)) { next(); return; }

    const fetchSite = req.headers['sec-fetch-site'];
    if (typeof fetchSite === 'string' && !OK_FETCH_SITE.has(fetchSite)) {
      res.status(403).json({ error: 'Cross-site request rejected' }); return;
    }
    const origin = originOf(req);
    if (!origin || !allowed.has(origin)) {
      res.status(403).json({ error: 'Origin not allowed' }); return;
    }
    const token = req.headers['x-csrf-token'];
    const expected = req.tester?.csrfToken;
    if (!expected || typeof token !== 'string' || !safeEqual(token, expected)) {
      res.status(403).json({ error: 'Invalid CSRF token' }); return;
    }
    next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/server && node --require ts-node/register --test src/middleware/csrf.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/server/src/middleware/csrf.ts dashboard/server/src/middleware/csrf.test.ts
git commit -m "feat(intake): CSRF guard (origin + fetch-metadata + token)"
```

---

## Task 9: Intake store (submit / list / get, idempotent)

**Files:**
- Create: `dashboard/server/src/intake/intakeStore.ts`
- Create: `dashboard/server/src/intake/intakeStore.test.ts`

**Interfaces:**
- Consumes: `getDb`, `randomId`, `recordAudit`.
- Produces:
  - `submitIntake(db, { testerId, title, body, productHint?, idempotencyKey? }): { intake: IntakeRow; deduped: boolean }` — validates caps (title ≤ 200, body ≤ 20000 chars `[PLAN-ASSUMPTION]`), treats tester text as inert data, and if `idempotencyKey` collides for the same tester returns the existing row with `deduped: true`.
  - `listIntakes(db, { testerId? }): IntakeSummary[]`; `getIntake(db, id): IntakeRow | null`.
  - Initial state is `'submitted'` (state machine: `submitted → triaged | needs_scope_review | ai_failed → decided → promoted/closed`; only `submitted` is created here — later states are M2).

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/server/src/intake/intakeStore.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { submitIntake, listIntakes, getIntake } from './intakeStore';

function seedTester(db: any) {
  db.prepare("INSERT INTO tester(id,label,created_at) VALUES('t1','T',1)").run();
}

test('submit creates a submitted intake and it is listable/gettable', () => {
  const db = openDb(':memory:'); runMigrations(db); seedTester(db);
  const { intake, deduped } = submitIntake(db, { testerId: 't1', title: 'Crash', body: 'steps' });
  assert.equal(deduped, false);
  assert.equal(intake.state, 'submitted');
  assert.equal(listIntakes(db, { testerId: 't1' }).length, 1);
  assert.equal(getIntake(db, intake.id)?.title, 'Crash');
});

test('same idempotency key for a tester dedupes instead of duplicating', () => {
  const db = openDb(':memory:'); runMigrations(db); seedTester(db);
  const a = submitIntake(db, { testerId: 't1', title: 'X', body: 'y', idempotencyKey: 'k1' });
  const b = submitIntake(db, { testerId: 't1', title: 'X', body: 'y', idempotencyKey: 'k1' });
  assert.equal(b.deduped, true);
  assert.equal(a.intake.id, b.intake.id);
  assert.equal(listIntakes(db, { testerId: 't1' }).length, 1);
});

test('rejects over-long title', () => {
  const db = openDb(':memory:'); runMigrations(db); seedTester(db);
  assert.throws(() => submitIntake(db, { testerId: 't1', title: 'x'.repeat(201), body: 'y' }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/intakeStore.test.ts`
Expected: FAIL with "Cannot find module './intakeStore'".

- [ ] **Step 3: Write implementation**

```typescript
// dashboard/server/src/intake/intakeStore.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/intakeStore.test.ts`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add dashboard/server/src/intake/intakeStore.ts dashboard/server/src/intake/intakeStore.test.ts
git commit -m "feat(intake): idempotent intake submit/list/get store"
```

---

## Task 10: Attachment store (content-sniff validation + caps)

**Files:**
- Create: `dashboard/server/src/intake/attachmentStore.ts`
- Create: `dashboard/server/src/intake/attachmentStore.test.ts`

**Interfaces:**
- Consumes: `getDb`, `randomId`, `intakeConfig.attachment`, `recordAudit`.
- Produces: `storeAttachment(db, { intakeId, originalName, buffer }): Promise<AttachmentRow>` — sniffs real MIME via `file-type` (never trusts extension; TXT/LOG have no magic bytes so allow when buffer is valid UTF-8 text and extension is `.txt`/`.log`), enforces `maxBytes`, `maxPerIntake`, `maxAggregateBytesPerIntake`; writes bytes to `attachmentDir` under a randomized `stored_name`; stores metadata + `content_hash`. Throws typed errors `TOO_LARGE`, `BAD_TYPE`, `TOO_MANY`, `AGGREGATE_EXCEEDED`. `deleteAttachment(db, id, actorId)` soft-deletes + unlinks file + audits.

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/server/src/intake/attachmentStore.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { makeAttachmentStore } from './attachmentStore';

// 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-att-'));
  const db = openDb(':memory:'); runMigrations(db);
  db.prepare("INSERT INTO tester(id,label,created_at) VALUES('t1','T',1)").run();
  db.prepare("INSERT INTO intake(id,tester_id,title,body,state,revision,created_at,updated_at) VALUES('i1','t1','a','b','submitted',1,1,1)").run();
  const store = makeAttachmentStore({
    attachmentDir: dir,
    caps: { maxBytes: 5_242_880, maxPerIntake: 2, maxAggregateBytesPerIntake: 10_000_000, allowedMime: ['image/png'] },
  });
  return { db, dir, store };
}

test('stores a valid PNG and writes the file to disk', async () => {
  const { db, dir, store } = setup();
  const row = await store.storeAttachment(db, { intakeId: 'i1', originalName: 'shot.png', buffer: PNG });
  assert.equal(row.mime, 'image/png');
  assert.ok(fs.existsSync(path.join(dir, row.stored_name)));
});

test('rejects a fake-extension file whose bytes are not an allowed type', async () => {
  const { db, store } = setup();
  const fake = Buffer.from('MZ\x90\x00 this is actually an exe');
  await assert.rejects(
    () => store.storeAttachment(db, { intakeId: 'i1', originalName: 'evil.png', buffer: fake }),
    /BAD_TYPE/
  );
});

test('enforces per-intake attachment count cap', async () => {
  const { db, store } = setup();
  await store.storeAttachment(db, { intakeId: 'i1', originalName: 'a.png', buffer: PNG });
  await store.storeAttachment(db, { intakeId: 'i1', originalName: 'b.png', buffer: PNG });
  await assert.rejects(
    () => store.storeAttachment(db, { intakeId: 'i1', originalName: 'c.png', buffer: PNG }),
    /TOO_MANY/
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/attachmentStore.test.ts`
Expected: FAIL with "Cannot find module './attachmentStore'".

- [ ] **Step 3: Write implementation**

```typescript
// dashboard/server/src/intake/attachmentStore.ts
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fromBuffer as fileTypeFromBuffer } from 'file-type'; // file-type@16 exports `fromBuffer` (NOT `fileTypeFromBuffer`, which is v17+ ESM-only)
import type { DB } from './db';
import { randomId, randomToken } from './crypto';
import { recordAudit } from './audit';

export interface AttachmentRow {
  id: string; intake_id: string; stored_name: string; original_name: string;
  mime: string; byte_size: number; content_hash: string; created_at: number;
}
export interface AttachmentCaps {
  maxBytes: number; maxPerIntake: number; maxAggregateBytesPerIntake: number; allowedMime: string[];
}

const TEXT_EXT = new Set(['.txt', '.log']);

function looksLikeUtf8Text(buf: Buffer): boolean {
  const sample = buf.subarray(0, 4096);
  if (sample.includes(0)) return false; // NUL byte => binary
  return Buffer.from(sample.toString('utf8'), 'utf8').length > 0;
}

export function makeAttachmentStore(cfg: { attachmentDir: string; caps: AttachmentCaps }) {
  async function resolveMime(originalName: string, buffer: Buffer): Promise<string> {
    const sniffed = await fileTypeFromBuffer(buffer);
    if (sniffed) return sniffed.mime; // magic-byte types (png/jpeg/webp)
    const ext = path.extname(originalName).toLowerCase();
    if (TEXT_EXT.has(ext) && looksLikeUtf8Text(buffer)) return 'text/plain';
    return 'application/octet-stream';
  }

  async function storeAttachment(
    db: DB, input: { intakeId: string; originalName: string; buffer: Buffer }
  ): Promise<AttachmentRow> {
    const { caps } = cfg;
    if (input.buffer.length > caps.maxBytes) throw new Error('TOO_LARGE');

    const existing = db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(byte_size),0) AS total FROM attachment WHERE intake_id = ? AND deleted_at IS NULL')
      .get(input.intakeId) as any;
    if (existing.n >= caps.maxPerIntake) throw new Error('TOO_MANY');
    if (existing.total + input.buffer.length > caps.maxAggregateBytesPerIntake) throw new Error('AGGREGATE_EXCEEDED');

    const mime = await resolveMime(input.originalName, input.buffer);
    if (!caps.allowedMime.includes(mime)) throw new Error('BAD_TYPE');

    const storedName = `${randomToken(16)}${path.extname(input.originalName).toLowerCase()}`;
    await fs.mkdir(cfg.attachmentDir, { recursive: true });
    await fs.writeFile(path.join(cfg.attachmentDir, storedName), input.buffer, { flag: 'wx' });

    const id = randomId('ATT');
    const now = Date.now();
    const contentHash = crypto.createHash('sha256').update(input.buffer).digest('hex');
    db.prepare(
      `INSERT INTO attachment(id,intake_id,stored_name,original_name,mime,byte_size,content_hash,created_at)
       VALUES(?,?,?,?,?,?,?,?)`
    ).run(id, input.intakeId, storedName, input.originalName, mime, input.buffer.length, contentHash, now);
    recordAudit(db, { kind: 'attachment_stored', actorKind: 'tester', intakeId: input.intakeId, detail: { id, mime } });
    return db.prepare('SELECT * FROM attachment WHERE id = ?').get(id) as AttachmentRow;
  }

  async function deleteAttachment(db: DB, id: string, actorId: string): Promise<void> {
    const row = db.prepare('SELECT * FROM attachment WHERE id = ? AND deleted_at IS NULL').get(id) as AttachmentRow | undefined;
    if (!row) return;
    db.prepare('UPDATE attachment SET deleted_at = ? WHERE id = ?').run(Date.now(), id);
    await fs.rm(path.join(cfg.attachmentDir, row.stored_name), { force: true });
    recordAudit(db, { kind: 'attachment_deleted', actorKind: 'admin', actorId, intakeId: row.intake_id, detail: { id } });
  }

  return { storeAttachment, deleteAttachment };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/attachmentStore.test.ts`
Expected: PASS (all three). `file-type@16.5.4` is CommonJS and exports `fromBuffer` (aliased to `fileTypeFromBuffer` in the import above); the v17+ named `fileTypeFromBuffer` export does not exist in v16. If the named import `{ fromBuffer }` fails under ts-node, fall back to `import * as fileType from 'file-type'` and call `fileType.fromBuffer(buffer)`.

- [ ] **Step 5: Commit**

```bash
git add dashboard/server/src/intake/attachmentStore.ts dashboard/server/src/intake/attachmentStore.test.ts
git commit -m "feat(intake): attachment store with content-sniff validation and caps"
```

---

## Task 11: Wire routes into Express (auth, intakes, attachments, admin)

**Files:**
- Create: `dashboard/server/src/routes/intake/auth.ts`
- Create: `dashboard/server/src/routes/intake/intakes.ts`
- Create: `dashboard/server/src/routes/intake/attachments.ts`
- Create: `dashboard/server/src/routes/intake/admin.ts`
- Create: `dashboard/server/src/routes/intake/index.ts`
- Create: `dashboard/server/src/routes/intake/intake.integration.test.ts`
- Modify: `dashboard/server/src/index.ts:26-36`

**Interfaces:**
- Consumes: all stores/middleware from Tasks 5–10, `intakeConfig`.
- Produces mounted routes (all under `/api/intake`, session-auth, **not** shared-bearer):
  - `POST /api/intake/session` — body `{ code }`; rate-limited by `WindowLimiter` keyed on `req.ip`; on success sets `intake_sid` cookie (HttpOnly, Secure, SameSite=Strict) and returns `{ csrfToken }`; on failure returns generic 401 and audits `code_exchange_failed`. On block returns 429 + `Retry-After`.
  - `DELETE /api/intake/session` — revokes session, clears cookie.
  - `POST /api/intake/intakes` — CSRF-guarded, submission-rate-limited; body `{ title, body, productHint?, idempotencyKey? }`; returns 201 + intake (200 if deduped).
  - `GET /api/intake/intakes` / `GET /api/intake/intakes/:id` — tester sees only own intakes.
  - `POST /api/intake/intakes/:id/attachments` — CSRF-guarded; raw body (≤ maxBytes) + `X-Filename` header; byte-budget-limited; returns 201; 413/415/429 on cap violations.
  - `admin.ts` (mounted under `/api/intake/admin`, admin-credential-guarded `[PLAN-ASSUMPTION]`: reuse existing shared bearer token as the admin capability for M1, since a full admin-credential UI is M3): `POST /codes` (issue), `DELETE /codes/:testerId` (revoke), `GET /throttled` (list throttled session keys), `DELETE /attachments/:id`.

- [ ] **Step 1: Write the failing integration test**

```typescript
// dashboard/server/src/routes/intake/intake.integration.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../../intake/db';
import { runMigrations } from '../../intake/migrations';
import { issueAccessCode } from '../../intake/accessCodeStore';
import { mountIntakeRoutes } from './index';

function makeApp() {
  const db = openDb(':memory:'); runMigrations(db);
  const app = express();
  mountIntakeRoutes(app, { db, allowedOrigins: ['https://intake.lan'], adminToken: 'admin-secret' });
  return { app, db };
}

async function call(app: any, method: string, path: string, opts: any = {}) {
  const { createServer } = await import('http');
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: opts.headers, body: opts.body,
  });
  const text = await res.text();
  server.close();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null,
    cookie: res.headers.get('set-cookie') };
}

test('code exchange → submit intake happy path with CSRF', async () => {
  const { app, db } = makeApp();
  const { code } = issueAccessCode(db, 'QA A');

  const login = await call(app, 'POST', '/api/intake/session', {
    headers: { 'content-type': 'application/json', origin: 'https://intake.lan' },
    body: JSON.stringify({ code }),
  });
  assert.equal(login.status, 200);
  const csrf = login.body.csrfToken;
  const sid = /intake_sid=([^;]+)/.exec(login.cookie || '')![1];

  const submit = await call(app, 'POST', '/api/intake/intakes', {
    headers: {
      'content-type': 'application/json', origin: 'https://intake.lan',
      'x-csrf-token': csrf, cookie: `intake_sid=${sid}`, 'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify({ title: 'Login crash', body: 'repro steps here' }),
  });
  assert.equal(submit.status, 201);
  assert.equal(submit.body.state, 'submitted');
});

test('submit without CSRF token is rejected 403', async () => {
  const { app, db } = makeApp();
  const { code } = issueAccessCode(db, 'QA B');
  const login = await call(app, 'POST', '/api/intake/session', {
    headers: { 'content-type': 'application/json', origin: 'https://intake.lan' },
    body: JSON.stringify({ code }),
  });
  const sid = /intake_sid=([^;]+)/.exec(login.cookie || '')![1];
  const submit = await call(app, 'POST', '/api/intake/intakes', {
    headers: { 'content-type': 'application/json', origin: 'https://intake.lan', cookie: `intake_sid=${sid}` },
    body: JSON.stringify({ title: 'x', body: 'y' }),
  });
  assert.equal(submit.status, 403);
});

test('bad code returns generic 401 (no enumeration)', async () => {
  const { app } = makeApp();
  const r = await call(app, 'POST', '/api/intake/session', {
    headers: { 'content-type': 'application/json', origin: 'https://intake.lan' },
    body: JSON.stringify({ code: 'definitely-wrong' }),
  });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'Invalid code'); // same message regardless of reason
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/server && node --require ts-node/register --test src/routes/intake/intake.integration.test.ts`
Expected: FAIL with "Cannot find module './index'".

- [ ] **Step 3: Write `auth.ts`**

```typescript
// dashboard/server/src/routes/intake/auth.ts
import { Router } from 'express';
import type { DB } from '../../intake/db';
import { verifyAccessCode } from '../../intake/accessCodeStore';
import { createSession, revokeSession } from '../../intake/sessionStore';
import { recordAudit } from '../../intake/audit';
import { WindowLimiter } from '../../intake/rateLimiter';
import { intakeConfig } from '../../intake/config';
import { requireTesterSession } from '../../middleware/testerSession';

export function buildAuthRouter(db: DB): Router {
  const router = Router();
  const limiter = new WindowLimiter(intakeConfig.codeExchange);

  router.post('/', (req, res) => {
    const key = req.ip || 'unknown';
    const gate = limiter.hit(key, Date.now());
    if (!gate.allowed) {
      recordAudit(db, { kind: 'code_exchange_throttled', actorKind: 'system', detail: { key, attempts: gate.attempts } });
      res.setHeader('Retry-After', Math.ceil(gate.retryAfterMs / 1000));
      res.status(429).json({ error: 'Too many attempts' });
      return;
    }
    const code = (req.body?.code ?? '').toString();
    const result = verifyAccessCode(db, code);
    if (!result.ok) {
      recordAudit(db, { kind: 'code_exchange_failed', actorKind: 'system', detail: { key } });
      res.status(401).json({ error: 'Invalid code' }); // generic, no enumeration
      return;
    }
    limiter.reset(key);
    const session = createSession(db, result.testerId, Date.now());
    recordAudit(db, { kind: 'session_created', actorKind: 'tester', actorId: result.testerId });
    res.cookie('intake_sid', session.sessionId, {
      httpOnly: true, secure: true, sameSite: 'strict', maxAge: intakeConfig.sessionTtlMs, path: '/api/intake',
    });
    res.status(200).json({ csrfToken: session.csrfToken, expiresAt: session.expiresAt });
  });

  router.delete('/', requireTesterSession, (req, res) => {
    revokeSession(db, req.tester!.sessionId);
    res.clearCookie('intake_sid', { path: '/api/intake' });
    res.status(204).end();
  });

  return router;
}
```

- [ ] **Step 4: Write `intakes.ts`**

```typescript
// dashboard/server/src/routes/intake/intakes.ts
import { Router } from 'express';
import type { DB } from '../../intake/db';
import { submitIntake, listIntakes, getIntake } from '../../intake/intakeStore';
import { WindowLimiter } from '../../intake/rateLimiter';
import { intakeConfig } from '../../intake/config';

export function buildIntakesRouter(db: DB): Router {
  const router = Router();
  const submitLimiter = new WindowLimiter({
    windowMs: intakeConfig.submission.windowMs,
    maxAttempts: intakeConfig.submission.maxPerWindow,
  });

  router.post('/', (req, res) => {
    const testerId = req.tester!.id;
    const gate = submitLimiter.hit(testerId, Date.now());
    if (!gate.allowed) {
      res.setHeader('Retry-After', Math.ceil(gate.retryAfterMs / 1000));
      res.status(429).json({ error: 'Submission rate exceeded' });
      return;
    }
    try {
      const { intake, deduped } = submitIntake(db, {
        testerId,
        title: req.body?.title, body: req.body?.body,
        productHint: req.body?.productHint, idempotencyKey: req.body?.idempotencyKey,
      });
      res.status(deduped ? 200 : 201).json(intake);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.get('/', (req, res) => {
    res.json(listIntakes(db, { testerId: req.tester!.id }));
  });

  router.get('/:id', (req, res) => {
    const row = getIntake(db, req.params.id);
    if (!row || row.tester_id !== req.tester!.id) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(row);
  });

  return router;
}
```

- [ ] **Step 5: Write `attachments.ts`**

```typescript
// dashboard/server/src/routes/intake/attachments.ts
import { Router, raw } from 'express';
import type { DB } from '../../intake/db';
import { getIntake } from '../../intake/intakeStore';
import { makeAttachmentStore } from '../../intake/attachmentStore';
import { ByteBudget } from '../../intake/rateLimiter';
import { intakeConfig } from '../../intake/config';

const ERR_STATUS: Record<string, number> = {
  TOO_LARGE: 413, BAD_TYPE: 415, TOO_MANY: 409, AGGREGATE_EXCEEDED: 409,
};

export function buildAttachmentsRouter(db: DB): Router {
  const router = Router({ mergeParams: true });
  const store = makeAttachmentStore({ attachmentDir: intakeConfig.attachmentDir, caps: intakeConfig.attachment });
  const budget = new ByteBudget({
    windowMs: intakeConfig.submission.windowMs,
    maxBytes: intakeConfig.submission.maxUploadBytesPerWindow,
  });

  router.post('/', raw({ type: '*/*', limit: intakeConfig.attachment.maxBytes }), async (req, res) => {
    const intakeId = req.params.id;
    const intake = getIntake(db, intakeId);
    if (!intake || intake.tester_id !== req.tester!.id) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const buffer = req.body as Buffer;
    const b = budget.charge(req.tester!.id, buffer.length, Date.now());
    if (!b.allowed) {
      res.setHeader('Retry-After', Math.ceil(b.retryAfterMs / 1000));
      res.status(429).json({ error: 'Upload byte budget exceeded' });
      return;
    }
    try {
      const row = await store.storeAttachment(db, {
        intakeId, originalName: (req.headers['x-filename'] as string) || 'upload.bin', buffer,
      });
      res.status(201).json({ id: row.id, mime: row.mime, byteSize: row.byte_size });
    } catch (e: any) {
      res.status(ERR_STATUS[e.message] ?? 400).json({ error: e.message });
    }
  });

  return router;
}
```

- [ ] **Step 6: Write `admin.ts` and `index.ts`**

```typescript
// dashboard/server/src/routes/intake/admin.ts
import { Router } from 'express';
import type { DB } from '../../intake/db';
import { issueAccessCode, revokeAccessCode } from '../../intake/accessCodeStore';
import { makeAttachmentStore } from '../../intake/attachmentStore';
import { intakeConfig } from '../../intake/config';
import { createAuthMiddleware } from '../../middleware/auth';

// M1: admin capability = the existing shared bearer token (adminToken).
export function buildAdminRouter(db: DB, adminToken: string | undefined): Router {
  const router = Router();
  router.use(createAuthMiddleware(adminToken));
  const store = makeAttachmentStore({ attachmentDir: intakeConfig.attachmentDir, caps: intakeConfig.attachment });

  router.post('/codes', (req, res) => {
    const label = (req.body?.label ?? '').toString().trim();
    if (!label) { res.status(400).json({ error: 'label required' }); return; }
    const { testerId, code } = issueAccessCode(db, label);
    res.status(201).json({ testerId, code }); // raw code shown once
  });

  router.delete('/codes/:testerId', (req, res) => {
    revokeAccessCode(db, req.params.testerId);
    res.status(204).end();
  });

  router.delete('/attachments/:id', async (req, res) => {
    await store.deleteAttachment(db, req.params.id, 'admin');
    res.status(204).end();
  });

  return router;
}
```

```typescript
// dashboard/server/src/routes/intake/index.ts
import type { Express } from 'express';
import { json } from 'express';
import type { DB } from '../../intake/db';
import { getDb } from '../../intake/db';
import { makeRequireTesterSession } from '../../middleware/testerSession';
import { makeCsrfGuard } from '../../middleware/csrf';
import { buildAuthRouter } from './auth';
import { buildIntakesRouter } from './intakes';
import { buildAttachmentsRouter } from './attachments';
import { buildAdminRouter } from './admin';

// Minimal cookie parser (avoids adding cookie-parser dependency).
function cookieParser(req: any, _res: any, next: any) {
  const header = req.headers.cookie;
  req.cookies = {};
  if (typeof header === 'string') {
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > -1) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  next();
}

export function mountIntakeRoutes(
  app: Express,
  opts: { db?: DB; allowedOrigins: string[]; adminToken: string | undefined }
): void {
  const db = opts.db ?? getDb();
  const requireSession = makeRequireTesterSession(() => db);
  const csrf = makeCsrfGuard({ allowedOrigins: opts.allowedOrigins });

  app.use('/api/intake', cookieParser);

  // Admin uses bearer token, not tester session — mount first.
  app.use('/api/intake/admin', json(), buildAdminRouter(db, opts.adminToken));

  // Auth: session create is public (rate-limited); logout needs session.
  app.use('/api/intake/session', json(), buildAuthRouter(db));

  // All remaining intake routes require a tester session + CSRF on unsafe methods.
  app.use('/api/intake/intakes/:id/attachments', requireSession, csrf, buildAttachmentsRouter(db));
  app.use('/api/intake/intakes', requireSession, csrf, json(), buildIntakesRouter(db));
}
```

- [ ] **Step 7: Run integration test to verify it passes**

Run: `cd dashboard/server && node --require ts-node/register --test src/routes/intake/intake.integration.test.ts`
Expected: PASS (all three).

- [ ] **Step 8: Wire into `index.ts`**

In `dashboard/server/src/index.ts`, after `app.use(express.json());` (line ~20) and **before** `app.use('/api', createAuthMiddleware(config.authToken));` (line ~26), add:

```typescript
import { mountIntakeRoutes } from './routes/intake';
// ...
// Intake Board (Central): tester surface uses its own session auth, NOT the
// shared bearer token — mount before the /api bearer guard so it is not shadowed.
mountIntakeRoutes(app, {
  allowedOrigins: config.allowedOrigins,
  adminToken: config.authToken,
});
```

Note: do **not** put `express.json()` globally over attachment raw-body routes — the intake router applies `json()` only where needed, and `raw()` on the attachments route.

- [ ] **Step 9: Run the full server test suite**

Run: `cd dashboard/server && npm test`
Expected: PASS — all existing tests plus new intake tests. No regressions.

- [ ] **Step 10: Commit**

```bash
git add dashboard/server/src/routes/intake dashboard/server/src/index.ts
git commit -m "feat(intake): wire session/intake/attachment/admin routes into Express"
```

---

## Task 12: Boot smoke + build check

**Files:**
- Modify: `dashboard/server/src/index.ts` (startup log only)

**Interfaces:** none new — this verifies the DB opens and migrations run at boot.

- [ ] **Step 1: Trigger DB init at boot**

In `index.ts`, inside the `app.listen` callback, add a line that calls `getDb()` so the SQLite file + migrations are created on startup (and any failure surfaces immediately):

```typescript
import { getDb } from './intake/db';
// inside app.listen callback:
getDb();
console.log('Intake SQLite ready');
```

- [ ] **Step 2: Type-check / build**

Run: `cd dashboard/server && npm run build`
Expected: `tsc` completes with no errors.

- [ ] **Step 3: Boot the server and smoke the endpoints**

Run (from repo root, using the dashboard dev server so the client is available too):

```bash
cd dashboard && INTAKE_DATA_DIR=./.intake-smoke DASHBOARD_AUTH_TOKEN=admin-secret npm run dev
```

In a second shell, issue a code, exchange it, and submit — verify 201:

```bash
# Issue a code (admin bearer)
curl -s -X POST localhost:4310/api/intake/admin/codes -H 'authorization: Bearer admin-secret' -H 'content-type: application/json' -d '{"label":"Smoke Tester"}'
```

Expected: JSON `{ "testerId": "...", "code": "..." }`. (Full cookie-based submit flow is covered by the Task 11 integration test; this step confirms the route is mounted and the admin path works against a real boot.)

- [ ] **Step 4: Clean up smoke DB and commit**

```bash
rm -rf dashboard/.intake-smoke
git add dashboard/server/src/index.ts
git commit -m "feat(intake): initialize SQLite at boot with startup smoke log"
```

- [ ] **Step 5: Confirm `.intake-smoke` / data dir is gitignored**

Check `.gitignore` includes the intake data dir so a live SQLite/attachment tree is never committed. If not present, add:

```
dashboard/.intake-smoke/
intake-data/
```

```bash
git add .gitignore
git commit -m "chore(intake): gitignore intake data directories"
```

---

## Milestone 1 Definition of Done

- Tester can exchange a valid access code for a Secure/HttpOnly/SameSite=Strict session cookie; invalid codes get a generic 401; brute-force is window-limited with 429 + `Retry-After` and audited.
- Tester can submit an intake (idempotent) and list/get only their own intakes; every mutation passes CSRF (Origin + Fetch-Metadata + token).
- Tester can attach PNG/JPEG/WebP/TXT/LOG (content-sniffed, extension not trusted) within per-file, per-intake count/aggregate, and per-session byte-budget caps; violations return 413/415/409/429.
- All writes go through the single SQLite writer; audit events are server-timestamped; migrations replay idempotently at boot.
- No `runs/` write path, no `run-agent.sh` invocation, no role/phase enum change exists in this milestone.
- `npm test` and `npm run build` are green.

---

## Milestone 2: Local workflow (OUTLINE — needs its own detailed plan)

Runs on the owner's Local machine; pulls from Central over HTTPS. Each task below becomes a full TDD task set in a follow-up plan.

- **M2-T1 Cursor retrieval client:** Local calls `GET /api/intake/changes?since=<cursor>` on Central; Central returns intakes/audit deltas after a durable cursor (Decision #14). Central adds the read-only changes endpoint; Local stores the last cursor durably. Refresh is read-only.
- **M2-T2 Claim protocol:** `POST /api/intake/intakes/:id/claim` with owner, revision, TTL; `renew`/`release`; revision-conflict → 409 (Decision #14). Abandoned claims expire and become claimable.
- **M2-T3 Repository allowlist + provenance:** Local resolves the system-selected product/service repo allowlist; records repo/branch/SHA/dirty/timestamp/machine (Decisions #5, #9). Tester text cannot expand scope; low-confidence → `needs_scope_review`.
- **M2-T4 Triage package export:** Local builds the bounded prompt + context manifest (intake, allowlist, provenance, approved snippets, prompt/schema version, context hash) (Decision #10). No auto-execution.
- **M2-T5 Triage result import + schema validation:** one versioned schema; invalid never treated as valid; posts validated result to Central; audits importer/provider/model/context hash (Decisions #10, #11). `ai_failed`/timeout visible + retryable.
- **M2-T6 Triage gate + override:** schema-valid triage required before promotion; admin override needs non-empty reason + records `triage_gate_overridden: true` (Decision #11).
- **M2-T7 Redacted promotion projection:** versioned safe projection (Decision #12) — allowed fields only, excludes codes/sessions/PII/raw attachments/secrets. Validated schema.
- **M2-T8 Idempotent `Accept & Promote`:** allocate collision-safe TASK ID, write `task.md` + minimal valid `status.yaml` at `phase: pending`, run existing `validate-yaml.rb`, record Intake↔TASK relationship, roll back / stay retryable on partial failure (Decision #6). Never invokes PM or dispatches a role. Confirm `intakes/` stays out of `office-git-sync.sh` pathspec; only the redacted `runs/<TASK-ID>` projection is team-synced.

## Milestone 3: LAN-release hardening (OUTLINE — needs its own detailed plan)

- **M3-T1 HTTPS reverse proxy + internal hostname + cert trust** (Decision #3): terminate TLS at an internal hostname; verify cookies are Secure end-to-end; document proxy config.
- **M3-T2 Admin credential + capability set** (Decision #2): replace the M1 bearer-token admin shim with a real admin credential (hashed) and capability model separate from testers.
- **M3-T3 Retention/deletion jobs** (Decision #7): closed-intake attachments deleted after 90 days; structured data retained 1 year; inactive sessions expire after 7 days; each deletion audited.
- **M3-T4 SQLite-consistent backup + restore** (Decision #13): online backup/snapshot (not a live-WAL copy), attachment manifest, 7 daily + 4 weekly rotation, backup-failure admin warning that does not block submissions, tested restore. Secrets/raw codes never in the backup.
- **M3-T5 Storage high-water enforcement + throttled-session admin view** (Decision #7): server-wide high-water mark blocks new uploads with a clear error; admin UI/endpoint lists throttled sessions.
- **M3-T6 End-to-end security/abuse verification** (Decisions #1–3, #7): cross-machine failure/recovery drills; penetration checks on CSRF/rate-limit/enumeration; verify no state-changing GET exists.

---

## Self-Review

**Spec coverage (14 decisions):** #1 topology/backend-enforced-auth → Tasks 7–8, 11 (M2/M3 complete the two-machine split); #2 tester identity + throttling → Tasks 5, 6, 11; #3 transport/CSRF → Tasks 8, 11 (TLS in M3-T1); #4 SQLite single writer → Tasks 2, 11; #5 AI source scope → M2-T3/T4; #6 promotion → M2-T8; #7 attachments/retention/abuse caps → Tasks 1, 6, 10, 11 (retention jobs M3-T3); #8 no-OpenAI provider → M2-T4 (manual session); #9 repo authority → M2-T3; #10 manual triage package → M2-T4/T5; #11 triage gate/override → M2-T6; #12 redaction → M2-T7; #13 backup → M3-T4; #14 cursor/claim → M2-T1/T2. Every decision maps to a task; M1 covers the Central-foundation subset in executable detail.

**Placeholder scan:** No "TBD"/"add validation"/"handle edge cases" — every code step has real code; M2/M3 are explicitly labeled outlines requiring their own plans, not placeholders inside M1.

**Type consistency:** `getDb()`/`openDb()`/`runMigrations()` consistent across Tasks 2–11; `hashSecret`/`verifySecret` signatures match Tasks 3/5/7; `WindowLimiter.hit()` return shape consistent Tasks 6/11; `IntakeRow`/`AttachmentRow` field names match store and route usage; `req.tester` shape declared once (Task 7) and consumed in Tasks 8/11.

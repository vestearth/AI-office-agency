# AI Dev Office Intake Board — Milestone 2 (Local Workflow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the owner-side Local workflow on top of the completed Central foundation (Milestone 1): the owner's machine pulls Central intake changes over HTTPS with a durable cursor, claims an intake, prepares a bounded read-only AI-triage package with repository provenance, imports the schema-validated triage result back to Central, and — after a triage gate — promotes an approved, redacted intake into a collision-safe `runs/<TASK-ID>` TASK at `phase: pending` without invoking PM or dispatching a role.

**Architecture:** Two deployments of the same `ai-dev-office/dashboard` codebase (Decision #1). **Central** (192.168.1.140) already owns the SQLite single-writer + tester surface from M1; M2 adds read-only change-feed, claim, and triage-import endpoints to the same Central Express app. **Local** (the owner's machine, the existing `localhost:4310` dashboard server) gains a Central-API client, a durable sync cursor, a repo-provenance + triage-package builder, a result importer, and an idempotent redacted promotion module that writes `runs/<TASK-ID>` on the Local (authoritative) clone. Local never opens the Central SQLite file — it goes through the Central HTTPS API (Decision #1, #14). Central never connects inbound to Local.

**Tech Stack:** Node.js + Express 4 + TypeScript, `better-sqlite3` (Central store, from M1), Node built-in `crypto`/`fs`/`https`, `js-yaml` (existing), the existing `ruby ai-dev-office/validate-yaml.rb` for TASK validation. Tests: Node's built-in test runner (`node --require ts-node/register --test`).

## Global Constraints

- **Repo scope:** All changes under `ai-dev-office/` (mostly `dashboard/`, plus reuse of `validate-yaml.rb`). Meta/tooling repo — **no `TASK-` run required**, no `status.yaml` of an existing run touched, no `knowledge-base/` edits.
- **`runs/` write boundary (ADR-0001, amended 2026-07-15):** M2 promotion CREATES a new run's initial artifacts (`task.md` + a minimal valid `status.yaml` at `phase: pending`) exactly as intake does. It MUST NOT mutate any existing run's `status.yaml`, MUST NOT invoke PM, MUST NOT dispatch or launch a role, MUST NOT call `run-agent.sh <id> <role>`. `Run PM / Start AI` stays a separate, deferred action.
- **Minimal valid `status.yaml` (verbatim required shape, from `validate-yaml.rb:125-135`):** keys `task_id` (must match `/^TASK(?:-[A-Z][A-Z0-9]*)?-\d+$/`), `phase` (∈ the PHASES enum; use `pending`), `iteration` (integer ≥ 0; use `0`), `current_agent` (∈ `pm dev dev-2 reviewer debugger devops free-roam done` OR `null`; use `null`). If `state` is present it MUST equal `phase`. Nothing else is required.
- **Closed enums:** never add `tester`, `ai`, or any intake role to the AGENTS/PHASES enums. Promotion's `current_agent` is `null`, never a made-up value.
- **Redaction is load-bearing (Decision #12):** promoted `task.md` + `status.yaml` are team-synced by `office-git-sync.sh` (allowlisted in `.gitignore`). The promotion projection MUST include only the Decision-#12 allowed fields and MUST exclude access codes, session/tokens, IP/UA/email, raw attachments/logs, full AI prompt/context/source snippets, detected secrets, and tester real name. Central SQLite stays the full-detail source; `intakes/` is never added to the git-sync pathspec.
- **Atomic local writes:** every Local filesystem write (sync cursor, promotion artifacts) uses the M1/`decisionStore.ts` pattern — write to a unique tmp path, `fsync`, `rename` — and per-key serialization where concurrent writes are possible.
- **Central is single-writer of SQLite (M1 invariant):** all new Central endpoints write through the one `getDb()` handle; Local never writes Central SQLite directly.
- **Read-only refresh (Decision #14):** the changes feed and any Local pull are read-only and never mutate intake state. Central never opens an inbound connection to Local.
- **Read-only AI triage (Decision #5):** triage inspects a system-selected repository allowlist read-only; tester text can never expand filesystem/repo/command scope; low-confidence/multi-product classification stops at `needs_scope_review`. No background/automatic executor in M2 (Decision #10) — the owner runs the package manually and imports the result.
- **Node test runner only:** `node --require ts-node/register --test`. No jest/vitest.
- **Path-scoped commits:** never `git add .` — unrelated untracked `runs/TASK-EAR-*` dirs exist; stage only each task's files.
- **`[PLAN-ASSUMPTION]`** marks choices beyond the locked decisions; the owner may override without reopening a decision.

## Prerequisite

Milestone 1 is merged to `main` (the Central foundation: SQLite schema, tester auth, intake/attachment stores, `intake/db.ts`, `intake/migrations.ts`, `intake/audit.ts`, `intake/intakeStore.ts`, `intake/config.ts`, the intake route tree). This plan builds directly on those modules and their exports.

---

## Scope & Sequencing

M2 has two subsystems that must be built Central-first (Local depends on the Central endpoints existing):

- **Phase A — Central API extensions** (Tasks 1–3): change-feed cursor, claim protocol, triage-result import. Mounted on the M1 intake route tree; extend the SQLite schema via a new idempotent migration.
- **Phase B — Local workflow** (Tasks 4–8): Central-API client + durable cursor, repo allowlist + provenance, triage-package export, triage gate + override, redacted promotion into `runs/`.

Each task ends with an independently testable deliverable. Build in order — later tasks consume earlier interfaces.

---

## File Structure (Milestone 2)

New (Central, Phase A):
- `dashboard/server/src/intake/migrations.ts` — MODIFY: append migration `version: 2` (claim, triage_result tables; intake `revision`/`seq` already exist from M1 — confirm and add a monotonic `change_seq` if absent).
- `dashboard/server/src/intake/changesStore.ts` — `listChangesSince(db, cursor, limit)` returning intake/audit deltas + the next cursor.
- `dashboard/server/src/intake/claimStore.ts` — `claimIntake`/`renewClaim`/`releaseClaim`/`getActiveClaim` with owner/revision/TTL/expiry.
- `dashboard/server/src/intake/triageStore.ts` — `importTriageResult` (validated), `getTriageResult`; sets intake state.
- `dashboard/server/src/intake/triageSchema.ts` — versioned triage-result schema + `validateTriageResult`.
- `dashboard/server/src/intake/intakeStore.ts` — MODIFY: add `setIntakeState(db, id, expectedRevision, newState)` with optimistic revision bump + server-derived audit.
- `dashboard/server/src/routes/intake/changes.ts` — `GET /api/intake/changes`.
- `dashboard/server/src/routes/intake/claim.ts` — claim/renew/release routes.
- `dashboard/server/src/routes/intake/triage.ts` — `POST /api/intake/intakes/:id/triage` (import), `GET .../triage`.
- `dashboard/server/src/routes/intake/index.ts` — MODIFY: mount the three new routers.

New (Local, Phase B):
- `dashboard/server/src/local/centralClient.ts` — HTTPS client for the Central API (changes/claim/triage/promotion-record).
- `dashboard/server/src/local/syncCursor.ts` — durable cursor read/write (atomic tmp+fsync+rename).
- `dashboard/server/src/local/repoProvenance.ts` — resolve allowlist + capture repo/branch/SHA/dirty/timestamp/machine.
- `dashboard/server/src/local/triagePackage.ts` — build the bounded prompt + context manifest + context hash.
- `dashboard/server/src/local/promotion.ts` — collision-safe TASK ID, redacted projection, artifact write + `validate-yaml.rb`, idempotency + rollback.
- `dashboard/server/src/local/promotionProjection.ts` — the Decision-#12 field allowlist/redaction projection (versioned).
- `dashboard/server/src/routes/local/*.ts` — Local admin routes (refresh, claim, export-package, import-result, promote) mounted only on the Local deployment.

Config:
- `dashboard/server/src/intake/config.ts` — MODIFY: add `claimTtlMs`, `centralBaseUrl`, `intakeRepoAllowlist`, `localMachineId`, `promotionSchemaVersion`.

---

## Task 1: Schema migration v2 + changes-feed store & route

**Files:**
- Modify: `dashboard/server/src/intake/migrations.ts`
- Create: `dashboard/server/src/intake/changesStore.ts`
- Create: `dashboard/server/src/intake/changesStore.test.ts`
- Create: `dashboard/server/src/routes/intake/changes.ts`
- Modify: `dashboard/server/src/routes/intake/index.ts`
- Create: `dashboard/server/src/routes/intake/changes.integration.test.ts`

**Interfaces:**
- Consumes (M1): `getDb`, `runMigrations`, `intakeConfig`, `makeRequireTesterSession`/admin bearer guard, `recordAudit`.
- Produces:
  - Migration `version: 2` adding `claim` and `triage_result` tables (used by Tasks 2–3) and a monotonic change column: `intake.change_seq INTEGER` maintained on every intake insert/state-change, backed by a `change_counter` singleton row (SQLite has no sequences), so the changes feed has a stable total order independent of wall-clock.
  - `listChangesSince(db, cursor: number, limit = 100): { changes: IntakeChange[]; nextCursor: number }` where `IntakeChange = { intakeId, state, revision, changeSeq, updatedAt }`. Ordered by `change_seq ASC`, `changeSeq > cursor`.
  - `GET /api/intake/changes?since=<cursor>&limit=<n>` — **admin-bearer-guarded** (Local pulls with the admin credential; testers cannot read the global feed), read-only, returns `{ changes, nextCursor }`. No state mutation (Decision #14).

- [ ] **Step 1: Write the failing store test**

```typescript
// dashboard/server/src/intake/changesStore.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { submitIntake } from './intakeStore';
import { listChangesSince } from './changesStore';

function seedTester(db: any, id = 't1') {
  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)').run(id, 'T', 1);
}

test('changes feed returns intakes after a cursor in change_seq order', () => {
  const db = openDb(':memory:'); runMigrations(db); seedTester(db);
  const a = submitIntake(db, { testerId: 't1', title: 'A', body: 'x' }).intake;
  const b = submitIntake(db, { testerId: 't1', title: 'B', body: 'y' }).intake;

  const first = listChangesSince(db, 0, 100);
  assert.equal(first.changes.length, 2);
  assert.ok(first.changes[0].changeSeq < first.changes[1].changeSeq);
  assert.equal(first.nextCursor, first.changes[1].changeSeq);

  // Only newer-than-cursor rows come back on the next pull.
  const afterFirst = listChangesSince(db, first.changes[0].changeSeq, 100);
  assert.equal(afterFirst.changes.length, 1);
  assert.equal(afterFirst.changes[0].intakeId, b.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/changesStore.test.ts`
Expected: FAIL — migration lacks `change_seq`/`change_counter` and `./changesStore` is missing.

- [ ] **Step 3: Append migration v2**

In `dashboard/server/src/intake/migrations.ts`, add to the `MIGRATIONS` array (do NOT modify version 1 — boot replays all; keep every statement `IF NOT EXISTS`):

```typescript
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS change_counter (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL);
      INSERT OR IGNORE INTO change_counter(id, seq) VALUES (1, 0);
      ALTER TABLE intake ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;
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
```

Note on `ALTER TABLE ... ADD COLUMN` idempotency: SQLite throws if the column already exists, which would break boot-replay. Guard it — wrap version-2 application so an "duplicate column name" error on the ALTER is swallowed while other statements still run. Implement by splitting the ALTER out of the transaction block: in `runMigrations`, after `db.exec(m.sql)` for versioned migrations, this specific ALTER must be attempted defensively. **Cleaner approach (use this):** replace the raw `ALTER` line with a runtime guard in `migrations.ts` — a helper `addColumnIfMissing(db, 'intake', 'change_seq', "INTEGER NOT NULL DEFAULT 0")` that checks `PRAGMA table_info(intake)` first and only issues the ALTER when absent. Put the helper in `migrations.ts` and call it from the version-2 apply path (keep the CREATE TABLE/INDEX statements in the `sql` string; move only the ALTER into the guarded helper). This preserves boot-replay idempotency.

- [ ] **Step 4: Maintain `change_seq` on intake writes**

In `dashboard/server/src/intake/intakeStore.ts` `submitIntake`, after allocating the intake and before the audit, bump the counter and stamp the row within the existing insert transaction. Add a shared helper in `changesStore.ts`:

```typescript
// dashboard/server/src/intake/changesStore.ts
import type { DB } from './db';

export interface IntakeChange {
  intakeId: string; state: string; revision: number; changeSeq: number; updatedAt: number;
}

// Allocates the next global change sequence (SQLite has no native sequences).
// Caller MUST run this inside the same transaction as the row write.
export function nextChangeSeq(db: DB): number {
  db.prepare('UPDATE change_counter SET seq = seq + 1 WHERE id = 1').run();
  return (db.prepare('SELECT seq FROM change_counter WHERE id = 1').get() as any).seq;
}

export function stampIntakeChange(db: DB, intakeId: string): number {
  const seq = nextChangeSeq(db);
  db.prepare('UPDATE intake SET change_seq = ?, updated_at = ? WHERE id = ?').run(seq, Date.now(), intakeId);
  return seq;
}

export function listChangesSince(db: DB, cursor: number, limit = 100): { changes: IntakeChange[]; nextCursor: number } {
  const rows = db.prepare(
    `SELECT id AS intakeId, state, revision, change_seq AS changeSeq, updated_at AS updatedAt
     FROM intake WHERE change_seq > ? ORDER BY change_seq ASC LIMIT ?`
  ).all(cursor, limit) as IntakeChange[];
  const nextCursor = rows.length ? rows[rows.length - 1].changeSeq : cursor;
  return { changes: rows, nextCursor };
}
```

In `submitIntake`, inside the insert transaction (right after the `INSERT INTO intake ...`), call `stampIntakeChange(db, id)` so every new intake gets a `change_seq`. (Import `stampIntakeChange` from `./changesStore`.)

- [ ] **Step 5: Run the store test to verify it passes**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/changesStore.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the changes route + integration test**

```typescript
// dashboard/server/src/routes/intake/changes.ts
import { Router } from 'express';
import type { DB } from '../../intake/db';
import { listChangesSince } from '../../intake/changesStore';
import { createAuthMiddleware } from '../../middleware/auth';

export function buildChangesRouter(db: DB, adminToken: string | undefined): Router {
  const router = Router();
  router.use(createAuthMiddleware(adminToken)); // Local pulls with the admin credential
  router.get('/', (req, res) => {
    const since = Number.parseInt(String(req.query.since ?? '0'), 10);
    const limit = Math.min(Number.parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
    const cursor = Number.isFinite(since) && since >= 0 ? since : 0;
    res.json(listChangesSince(db, cursor, limit)); // read-only (Decision #14)
  });
  return router;
}
```

```typescript
// dashboard/server/src/routes/intake/changes.integration.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../../intake/db';
import { runMigrations } from '../../intake/migrations';
import { submitIntake } from '../../intake/intakeStore';
import { buildChangesRouter } from './changes';

async function call(app: any, path: string, headers: any = {}) {
  const { createServer } = await import('http');
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  const body = await res.json();
  server.close();
  return { status: res.status, body };
}

test('changes route requires admin token and returns deltas', async () => {
  const db = openDb(':memory:'); runMigrations(db);
  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)').run('t1', 'T', 1);
  submitIntake(db, { testerId: 't1', title: 'A', body: 'x' });
  const app = express();
  app.use('/api/intake/changes', buildChangesRouter(db, 'admin-secret'));

  const noAuth = await call(app, '/api/intake/changes?since=0');
  assert.equal(noAuth.status, 401);

  const ok = await call(app, '/api/intake/changes?since=0', { authorization: 'Bearer admin-secret' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.changes.length, 1);
  assert.ok(ok.body.nextCursor > 0);
});
```

- [ ] **Step 7: Mount + run integration test**

In `dashboard/server/src/routes/intake/index.ts`, inside `mountIntakeRoutes`, add (near the admin mount, bearer-guarded, before the tester routes):

```typescript
import { buildChangesRouter } from './changes';
// ...
app.use('/api/intake/changes', buildChangesRouter(db, opts.adminToken));
```

Run: `cd dashboard/server && node --require ts-node/register --test src/routes/intake/changes.integration.test.ts src/intake/changesStore.test.ts`
Expected: PASS. Then `cd dashboard/server && npm test` (full suite green — the new `change_seq` column and migration v2 must not break M1 tests) and `npm run build`.

- [ ] **Step 8: Commit**

```bash
git add dashboard/server/src/intake/migrations.ts dashboard/server/src/intake/changesStore.ts dashboard/server/src/intake/changesStore.test.ts dashboard/server/src/intake/intakeStore.ts dashboard/server/src/routes/intake/changes.ts dashboard/server/src/routes/intake/changes.integration.test.ts dashboard/server/src/routes/intake/index.ts
git commit -m "feat(intake): migration v2 + admin-guarded cursor changes feed"
```

---

## Task 2: Claim protocol (claim / renew / release, revision-aware)

**Files:**
- Create: `dashboard/server/src/intake/claimStore.ts`
- Create: `dashboard/server/src/intake/claimStore.test.ts`
- Create: `dashboard/server/src/routes/intake/claim.ts`
- Modify: `dashboard/server/src/routes/intake/index.ts`
- Modify: `dashboard/server/src/intake/config.ts` (add `claimTtlMs`)

**Interfaces:**
- Consumes: `getDb`, `getIntake` (M1), `recordAudit`, `intakeConfig.claimTtlMs`.
- Produces:
  - `claimIntake(db, { intakeId, owner, expectedRevision, now, ttlMs }): { ok: true; claim } | { ok: false; reason: 'not_found' | 'revision_conflict' | 'already_claimed' }` — a fresh claim requires no active claim (or an expired one) and `expectedRevision === intake.revision`; records owner/revision/expiry.
  - `renewClaim(db, { claimId, owner, now, ttlMs })` and `releaseClaim(db, { claimId, owner })` — owner-scoped; renewing a claim not owned by `owner` fails.
  - `getActiveClaim(db, intakeId, now)` — the non-released, non-expired claim or null.
  - Routes (admin-bearer-guarded — the owner claims from Local): `POST /api/intake/intakes/:id/claim` (body `{ owner, expectedRevision }` → 201 | 404 | 409), `POST .../claim/renew`, `POST .../claim/release`. Revision conflict → 409 (Decision #14: abandoned claims become claimable after TTL without duplicate processing).

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/server/src/intake/claimStore.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { submitIntake } from './intakeStore';
import { claimIntake, renewClaim, releaseClaim, getActiveClaim } from './claimStore';

function seed(db: any) {
  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)').run('t1', 'T', 1);
  return submitIntake(db, { testerId: 't1', title: 'A', body: 'x' }).intake;
}

test('first claim succeeds; second concurrent claim is rejected until expiry', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const intake = seed(db);
  const now = 1000;
  const a = claimIntake(db, { intakeId: intake.id, owner: 'earth', expectedRevision: intake.revision, now, ttlMs: 500 });
  assert.equal(a.ok, true);
  const b = claimIntake(db, { intakeId: intake.id, owner: 'bob', expectedRevision: intake.revision, now: now + 100, ttlMs: 500 });
  assert.deepEqual(b, { ok: false, reason: 'already_claimed' });
  // After TTL, the intake becomes claimable again (abandoned work).
  const c = claimIntake(db, { intakeId: intake.id, owner: 'bob', expectedRevision: intake.revision, now: now + 600, ttlMs: 500 });
  assert.equal(c.ok, true);
});

test('revision mismatch is a conflict, not a claim', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const intake = seed(db);
  const r = claimIntake(db, { intakeId: intake.id, owner: 'earth', expectedRevision: intake.revision + 5, now: 1, ttlMs: 500 });
  assert.deepEqual(r, { ok: false, reason: 'revision_conflict' });
});

test('renew/release are owner-scoped', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const intake = seed(db);
  const a: any = claimIntake(db, { intakeId: intake.id, owner: 'earth', expectedRevision: intake.revision, now: 1, ttlMs: 500 });
  assert.equal(renewClaim(db, { claimId: a.claim.id, owner: 'bob', now: 2, ttlMs: 500 }).ok, false);
  assert.equal(renewClaim(db, { claimId: a.claim.id, owner: 'earth', now: 2, ttlMs: 500 }).ok, true);
  releaseClaim(db, { claimId: a.claim.id, owner: 'earth' });
  assert.equal(getActiveClaim(db, intake.id, 3), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/claimStore.test.ts`
Expected: FAIL — `./claimStore` missing.

- [ ] **Step 3: Add `claimTtlMs` to config**

In `dashboard/server/src/intake/config.ts`, add to the `IntakeConfig` interface `claimTtlMs: number;` and in `loadIntakeConfig` `claimTtlMs: int(env.INTAKE_CLAIM_TTL_MS, 30 * 60 * 1000), // 30 min default [PLAN-ASSUMPTION]`. Add `INTAKE_CLAIM_TTL_MS=1800000` to `.env.example`.

- [ ] **Step 4: Implement `claimStore.ts`**

```typescript
// dashboard/server/src/intake/claimStore.ts
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
```

- [ ] **Step 5: Run the store test to verify it passes**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/claimStore.test.ts`
Expected: PASS (all three).

- [ ] **Step 6: Route + mount**

```typescript
// dashboard/server/src/routes/intake/claim.ts
import { Router } from 'express';
import { json } from 'express';
import type { DB } from '../../intake/db';
import { claimIntake, renewClaim, releaseClaim } from '../../intake/claimStore';
import { intakeConfig } from '../../intake/config';
import { createAuthMiddleware } from '../../middleware/auth';

const REASON_STATUS: Record<string, number> = { not_found: 404, revision_conflict: 409, already_claimed: 409 };

export function buildClaimRouter(db: DB, adminToken: string | undefined): Router {
  const router = Router({ mergeParams: true });
  router.use(createAuthMiddleware(adminToken), json());
  router.post('/', (req, res) => {
    const r = claimIntake(db, {
      intakeId: req.params.id, owner: String(req.body?.owner ?? '').trim(),
      expectedRevision: Number(req.body?.expectedRevision), now: Date.now(), ttlMs: intakeConfig.claimTtlMs,
    });
    if (!r.ok) { res.status(REASON_STATUS[r.reason]).json({ error: r.reason }); return; }
    res.status(201).json(r.claim);
  });
  router.post('/renew', (req, res) => {
    const r = renewClaim(db, { claimId: String(req.body?.claimId), owner: String(req.body?.owner ?? '').trim(), now: Date.now(), ttlMs: intakeConfig.claimTtlMs });
    res.status(r.ok ? 200 : 409).json(r);
  });
  router.post('/release', (req, res) => {
    const r = releaseClaim(db, { claimId: String(req.body?.claimId), owner: String(req.body?.owner ?? '').trim() });
    res.status(r.ok ? 200 : 409).json(r);
  });
  return router;
}
```

In `index.ts` `mountIntakeRoutes`, mount before the tester routes:

```typescript
import { buildClaimRouter } from './claim';
app.use('/api/intake/intakes/:id/claim', buildClaimRouter(db, opts.adminToken));
```

- [ ] **Step 7: Run full suite + build, then commit**

Run: `cd dashboard/server && npm test && npm run build`
Expected: green.

```bash
git add dashboard/server/src/intake/claimStore.ts dashboard/server/src/intake/claimStore.test.ts dashboard/server/src/routes/intake/claim.ts dashboard/server/src/routes/intake/index.ts dashboard/server/src/intake/config.ts dashboard/server/.env.example
git commit -m "feat(intake): revision-aware claim/renew/release protocol"
```

---

## Task 3: Triage schema + import store + route (with intake state transition)

**Files:**
- Create: `dashboard/server/src/intake/triageSchema.ts`
- Create: `dashboard/server/src/intake/triageSchema.test.ts`
- Create: `dashboard/server/src/intake/triageStore.ts`
- Create: `dashboard/server/src/intake/triageStore.test.ts`
- Modify: `dashboard/server/src/intake/intakeStore.ts` (add `setIntakeState`)
- Create: `dashboard/server/src/routes/intake/triage.ts`
- Modify: `dashboard/server/src/routes/intake/index.ts`

**Interfaces:**
- Consumes: `getDb`, `getIntake`, `recordAudit`, `stampIntakeChange` (Task 1).
- Produces:
  - `triageSchema.ts`: `TRIAGE_SCHEMA_VERSION = 'triage.v1'`; `validateTriageResult(obj): { ok: true; value: TriageResult } | { ok: false; errors: string[] }`. `TriageResult` fields (Decision #5/#10/#12): `schemaVersion` (must equal the version), `classification` (`'triaged' | 'needs_scope_review' | 'ai_failed'`), `ownerRecommendation?`, `impact?`, `missingInfo?: string[]`, `riskFlags?: string[]`, `duplicateCandidates?: string[]`, `summary` (string), `contextHash` (string), `provider?` (string). No source snippets, no secrets — the importer strips anything outside the schema.
  - `intakeStore.setIntakeState(db, id, expectedRevision, newState): { ok: true; revision } | { ok: false; reason: 'not_found' | 'revision_conflict' }` — optimistic-revision bump + `stampIntakeChange` + server-derived audit; `newState` ∈ the intake state machine (`triaged | needs_scope_review | ai_failed | decided | promoted | closed`).
  - `triageStore.importTriageResult(db, { intakeId, expectedRevision, raw, importer, repoProvenance?, gateOverridden? }): { ok: true; state } | { ok: false; reason }` — validates via schema (invalid never treated as valid — Decision #11), stores the row, transitions the intake state to the classification, audits importer/provider/contextHash/repo-revisions (Decision #10). A failed/timeout triage imported as `classification: 'ai_failed'` leaves the intake retryable/visible (Decision #5).
  - Route (admin-bearer): `POST /api/intake/intakes/:id/triage` → 201 (imported) | 400 (schema-invalid, with errors) | 404 | 409 (revision conflict). `GET .../triage` returns the latest result.

- [ ] **Step 1: Write the failing schema + store tests**

```typescript
// dashboard/server/src/intake/triageSchema.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTriageResult, TRIAGE_SCHEMA_VERSION } from './triageSchema';

const good = {
  schemaVersion: TRIAGE_SCHEMA_VERSION, classification: 'triaged',
  summary: 'Looks like a wallet debit bug', contextHash: 'abc123',
};

test('valid triage result passes and strips unknown fields', () => {
  const r = validateTriageResult({ ...good, sneakySecret: 'AKIA...', sourceSnippet: 'code' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal((r.value as any).sneakySecret, undefined); // stripped
    assert.equal((r.value as any).sourceSnippet, undefined);
    assert.equal(r.value.classification, 'triaged');
  }
});

test('wrong schema version and bad classification are rejected', () => {
  assert.equal(validateTriageResult({ ...good, schemaVersion: 'triage.v0' }).ok, false);
  assert.equal(validateTriageResult({ ...good, classification: 'promoted' }).ok, false);
  assert.equal(validateTriageResult({ summary: 'x' }).ok, false); // missing required
});
```

```typescript
// dashboard/server/src/intake/triageStore.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { submitIntake, getIntake } from './intakeStore';
import { importTriageResult } from './triageStore';
import { TRIAGE_SCHEMA_VERSION } from './triageSchema';

function seed(db: any) {
  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)').run('t1', 'T', 1);
  return submitIntake(db, { testerId: 't1', title: 'A', body: 'x' }).intake;
}
const result = { schemaVersion: TRIAGE_SCHEMA_VERSION, classification: 'triaged', summary: 's', contextHash: 'h' };

test('valid import transitions intake state to the classification and stores the row', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const intake = seed(db);
  const r = importTriageResult(db, { intakeId: intake.id, expectedRevision: intake.revision, raw: result, importer: 'earth' });
  assert.equal(r.ok, true);
  assert.equal(getIntake(db, intake.id)!.state, 'triaged');
  assert.equal((db.prepare('SELECT COUNT(*) c FROM triage_result').get() as any).c, 1);
});

test('schema-invalid import is rejected and does not change intake state', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const intake = seed(db);
  const r = importTriageResult(db, { intakeId: intake.id, expectedRevision: intake.revision, raw: { bad: true }, importer: 'earth' });
  assert.equal(r.ok, false);
  assert.equal(getIntake(db, intake.id)!.state, 'submitted'); // unchanged
});

test('revision conflict is rejected', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const intake = seed(db);
  const r = importTriageResult(db, { intakeId: intake.id, expectedRevision: intake.revision + 3, raw: result, importer: 'earth' });
  assert.equal(r.ok, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/triageSchema.test.ts src/intake/triageStore.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement `triageSchema.ts`**

```typescript
// dashboard/server/src/intake/triageSchema.ts
export const TRIAGE_SCHEMA_VERSION = 'triage.v1';
const CLASSIFICATIONS = ['triaged', 'needs_scope_review', 'ai_failed'] as const;
export type TriageClassification = (typeof CLASSIFICATIONS)[number];

export interface TriageResult {
  schemaVersion: string;
  classification: TriageClassification;
  summary: string;
  contextHash: string;
  provider?: string;
  ownerRecommendation?: string;
  impact?: string;
  missingInfo?: string[];
  riskFlags?: string[];
  duplicateCandidates?: string[];
}

const str = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
const strArr = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'));

export function validateTriageResult(obj: unknown): { ok: true; value: TriageResult } | { ok: false; errors: string[] } {
  const e: string[] = [];
  const o = (obj ?? {}) as Record<string, unknown>;
  if (o.schemaVersion !== TRIAGE_SCHEMA_VERSION) e.push(`schemaVersion must be ${TRIAGE_SCHEMA_VERSION}`);
  if (!CLASSIFICATIONS.includes(o.classification as any)) e.push(`classification must be one of ${CLASSIFICATIONS.join(', ')}`);
  if (!str(o.summary)) e.push('summary required');
  if (!str(o.contextHash)) e.push('contextHash required');
  if (o.provider !== undefined && !str(o.provider)) e.push('provider must be a non-empty string when present');
  for (const f of ['ownerRecommendation', 'impact'] as const) if (o[f] !== undefined && !str(o[f])) e.push(`${f} must be a string`);
  for (const f of ['missingInfo', 'riskFlags', 'duplicateCandidates'] as const) if (!strArr(o[f])) e.push(`${f} must be a string[]`);
  if (e.length) return { ok: false, errors: e };
  // Strip to schema fields ONLY — anything extra (source snippets, secrets) is discarded (Decision #12).
  const value: TriageResult = {
    schemaVersion: TRIAGE_SCHEMA_VERSION, classification: o.classification as TriageClassification,
    summary: o.summary as string, contextHash: o.contextHash as string,
    provider: o.provider as string | undefined, ownerRecommendation: o.ownerRecommendation as string | undefined,
    impact: o.impact as string | undefined, missingInfo: o.missingInfo as string[] | undefined,
    riskFlags: o.riskFlags as string[] | undefined, duplicateCandidates: o.duplicateCandidates as string[] | undefined,
  };
  return { ok: true, value };
}
```

- [ ] **Step 4: Add `setIntakeState` to `intakeStore.ts`**

```typescript
// append to dashboard/server/src/intake/intakeStore.ts
import { stampIntakeChange } from './changesStore';

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
```

- [ ] **Step 5: Implement `triageStore.ts`**

```typescript
// dashboard/server/src/intake/triageStore.ts
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/triageSchema.test.ts src/intake/triageStore.test.ts`
Expected: PASS (all).

- [ ] **Step 7: Route + mount + full suite + build + commit**

```typescript
// dashboard/server/src/routes/intake/triage.ts
import { Router, json } from 'express';
import type { DB } from '../../intake/db';
import { importTriageResult, getLatestTriage } from '../../intake/triageStore';
import { createAuthMiddleware } from '../../middleware/auth';

const REASON_STATUS: Record<string, number> = { not_found: 404, revision_conflict: 409, schema_invalid: 400 };

export function buildTriageRouter(db: DB, adminToken: string | undefined): Router {
  const router = Router({ mergeParams: true });
  router.use(createAuthMiddleware(adminToken), json({ limit: '256kb' }));
  router.post('/', (req, res) => {
    const r = importTriageResult(db, {
      intakeId: req.params.id, expectedRevision: Number(req.body?.expectedRevision),
      raw: req.body?.result, importer: String(req.body?.importer ?? '').trim(),
      repoProvenance: req.body?.repoProvenance, gateOverridden: !!req.body?.gateOverridden,
    });
    if (!r.ok) { res.status(REASON_STATUS[r.reason]).json({ error: r.reason, errors: (r as any).errors }); return; }
    res.status(201).json(r);
  });
  router.get('/', (req, res) => res.json(getLatestTriage(db, req.params.id) ?? {}));
  return router;
}
```

Mount in `index.ts`: `app.use('/api/intake/intakes/:id/triage', buildTriageRouter(db, opts.adminToken));`

Run: `cd dashboard/server && npm test && npm run build` → green.

```bash
git add dashboard/server/src/intake/triageSchema.ts dashboard/server/src/intake/triageSchema.test.ts dashboard/server/src/intake/triageStore.ts dashboard/server/src/intake/triageStore.test.ts dashboard/server/src/intake/intakeStore.ts dashboard/server/src/routes/intake/triage.ts dashboard/server/src/routes/intake/index.ts
git commit -m "feat(intake): versioned triage schema, validated import, intake state transition"
```

---

## Task 4: Local — Central API client + durable sync cursor

**Files:**
- Create: `dashboard/server/src/local/centralClient.ts`
- Create: `dashboard/server/src/local/centralClient.test.ts`
- Create: `dashboard/server/src/local/syncCursor.ts`
- Create: `dashboard/server/src/local/syncCursor.test.ts`
- Modify: `dashboard/server/src/intake/config.ts` (add `centralBaseUrl`, `localMachineId`)

**Interfaces:**
- Produces:
  - `centralClient.ts`: `makeCentralClient({ baseUrl, adminToken, fetchImpl? })` → `{ getChanges(since), claim(intakeId, owner, revision), renewClaim/releaseClaim, importTriage(intakeId, body), recordPromotion(intakeId, body) }`. Uses injected `fetchImpl` (default global `fetch`) so tests stub HTTP. All calls send `Authorization: Bearer <adminToken>` (Decision #1: capability, not URL/tab trust). Read-only `getChanges` (Decision #14).
  - `syncCursor.ts`: `readCursor(path)` / `writeCursor(path, seq)` — durable atomic write (tmp+fsync+rename per M1 `decisionStore` pattern). Cursor persists the last `change_seq` consumed so refresh fetches only newer changes (Decision #14).

- [ ] **Step 1: Write failing tests**

```typescript
// dashboard/server/src/local/syncCursor.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { readCursor, writeCursor } from './syncCursor';

test('cursor round-trips and defaults to 0 when absent', async () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cur-')), 'cursor.json');
  assert.equal(await readCursor(p), 0);
  await writeCursor(p, 42);
  assert.equal(await readCursor(p), 42);
});
```

```typescript
// dashboard/server/src/local/centralClient.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCentralClient } from './centralClient';

test('getChanges calls the changes endpoint with the bearer token and since cursor', async () => {
  const calls: any[] = [];
  const fakeFetch = async (url: string, opts: any) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ changes: [], nextCursor: 0 }) } as any;
  };
  const client = makeCentralClient({ baseUrl: 'https://central.lan', adminToken: 'admin-secret', fetchImpl: fakeFetch as any });
  await client.getChanges(7);
  assert.match(calls[0].url, /\/api\/intake\/changes\?since=7/);
  assert.equal(calls[0].opts.headers.authorization, 'Bearer admin-secret');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd dashboard/server && node --require ts-node/register --test src/local/syncCursor.test.ts src/local/centralClient.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement `syncCursor.ts`** (atomic write, M1 pattern)

```typescript
// dashboard/server/src/local/syncCursor.ts
import fs from 'fs/promises';
import path from 'path';

export async function readCursor(cursorPath: string): Promise<number> {
  try {
    const data = JSON.parse(await fs.readFile(cursorPath, 'utf8'));
    return Number.isFinite(data?.seq) && data.seq >= 0 ? data.seq : 0;
  } catch { return 0; }
}

let tmpCounter = 0;
export async function writeCursor(cursorPath: string, seq: number): Promise<void> {
  await fs.mkdir(path.dirname(cursorPath), { recursive: true });
  const tmp = `${cursorPath}.tmp.${process.pid}.${tmpCounter++}`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify({ seq }), 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  await fs.rename(tmp, cursorPath);
}
```

- [ ] **Step 4: Implement `centralClient.ts`**

```typescript
// dashboard/server/src/local/centralClient.ts
type FetchImpl = typeof fetch;

export function makeCentralClient(opts: { baseUrl: string; adminToken: string; fetchImpl?: FetchImpl }) {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const auth = { authorization: `Bearer ${opts.adminToken}`, 'content-type': 'application/json' };

  async function req(method: string, pathPart: string, body?: unknown): Promise<any> {
    const res = await f(`${base}${pathPart}`, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Central ${method} ${pathPart} -> ${res.status} ${text}`);
    }
    return res.json().catch(() => ({}));
  }

  return {
    getChanges: (since: number) => req('GET', `/api/intake/changes?since=${encodeURIComponent(since)}`),
    claim: (intakeId: string, owner: string, expectedRevision: number) =>
      req('POST', `/api/intake/intakes/${encodeURIComponent(intakeId)}/claim`, { owner, expectedRevision }),
    renewClaim: (intakeId: string, claimId: string, owner: string) =>
      req('POST', `/api/intake/intakes/${encodeURIComponent(intakeId)}/claim/renew`, { claimId, owner }),
    releaseClaim: (intakeId: string, claimId: string, owner: string) =>
      req('POST', `/api/intake/intakes/${encodeURIComponent(intakeId)}/claim/release`, { claimId, owner }),
    importTriage: (intakeId: string, body: object) =>
      req('POST', `/api/intake/intakes/${encodeURIComponent(intakeId)}/triage`, body),
    recordPromotion: (intakeId: string, body: object) =>
      req('POST', `/api/intake/intakes/${encodeURIComponent(intakeId)}/promotion`, body),
  };
}
```

Add to `config.ts`: `centralBaseUrl: (env.INTAKE_CENTRAL_BASE_URL || '').trim()` and `localMachineId: (env.INTAKE_LOCAL_MACHINE_ID || os.hostname()).trim()` (`[PLAN-ASSUMPTION]`; import `os`). Document both in `.env.example`.

- [ ] **Step 5: Run tests → pass; commit**

Run: `cd dashboard/server && node --require ts-node/register --test src/local/*.test.ts` → PASS. Then `npm test && npm run build`.

```bash
git add dashboard/server/src/local/centralClient.ts dashboard/server/src/local/centralClient.test.ts dashboard/server/src/local/syncCursor.ts dashboard/server/src/local/syncCursor.test.ts dashboard/server/src/intake/config.ts dashboard/server/.env.example
git commit -m "feat(intake-local): Central API client and durable sync cursor"
```

---

## Task 5: Local — repository allowlist + provenance capture

**Files:**
- Create: `dashboard/server/src/local/repoProvenance.ts`
- Create: `dashboard/server/src/local/repoProvenance.test.ts`
- Modify: `dashboard/server/src/intake/config.ts` (add `intakeRepoAllowlist`)

**Interfaces:**
- Produces:
  - `resolveAllowedRepos(config): { name: string; path: string }[]` — from a configured allowlist ONLY (Decision #5: system-selected; tester text can never add a repo). Repos not in the allowlist are unreachable.
  - `captureProvenance(repoPath, runGit?): { repo, branch, sha, dirty, capturedAt, machine }` — runs `git rev-parse`/`status --porcelain` via an injectable `runGit` (default spawns git); records branch/SHA/dirty/timestamp/machine (Decision #9). Never pulls/resets/syncs.
  - `classifyScope(intake, allowlist): { repos: string[]; needsScopeReview: boolean }` — maps an intake's `product_hint` to allowlisted repos; **empty or ambiguous (>1 candidate with low confidence) ⇒ `needsScopeReview: true`** and an empty repo set (Decision #5: stop at `needs_scope_review`, never broaden).

- [ ] **Step 1: Write failing test** (injectable git + allowlist, deterministic)

```typescript
// dashboard/server/src/local/repoProvenance.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureProvenance, classifyScope } from './repoProvenance';

test('captureProvenance records branch/sha/dirty via injected git, never mutating', () => {
  const runGit = (args: string[]) => {
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main';
    if (args[0] === 'rev-parse') return 'deadbeef';
    if (args[0] === 'status') return ' M file.ts\n'; // dirty
    throw new Error('unexpected git ' + args.join(' '));
  };
  const p = captureProvenance('/repos/Games-Labs-Wallet', runGit, () => 1700, 'central-1');
  assert.equal(p.branch, 'main'); assert.equal(p.sha, 'deadbeef');
  assert.equal(p.dirty, true); assert.equal(p.machine, 'central-1'); assert.equal(p.capturedAt, 1700);
});

test('ambiguous/empty scope stops at needs_scope_review with no repos', () => {
  const allow = [{ name: 'Games-Labs-Wallet', path: '/r/w' }, { name: 'Games-Labs-Missions', path: '/r/m' }];
  assert.deepEqual(classifyScope({ product_hint: null } as any, allow), { repos: [], needsScopeReview: true });
  assert.deepEqual(classifyScope({ product_hint: 'wallet' } as any, allow), { repos: ['Games-Labs-Wallet'], needsScopeReview: false });
  // tester text naming a repo NOT in the allowlist cannot add it
  assert.deepEqual(classifyScope({ product_hint: 'some-other-service' } as any, allow), { repos: [], needsScopeReview: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/server && node --require ts-node/register --test src/local/repoProvenance.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `repoProvenance.ts`**

```typescript
// dashboard/server/src/local/repoProvenance.ts
import { execFileSync } from 'child_process';

export interface RepoRef { name: string; path: string; }
export interface Provenance { repo: string; branch: string; sha: string; dirty: boolean; capturedAt: number; machine: string; }

export type RunGit = (args: string[]) => string;

const defaultRunGit = (repoPath: string): RunGit => (args) =>
  execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' });

export function captureProvenance(
  repoPath: string, runGit?: RunGit, now: () => number = () => Date.now(), machine = ''
): Provenance {
  const git = runGit ?? defaultRunGit(repoPath);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const sha = git(['rev-parse', 'HEAD']).trim();
  const dirty = git(['status', '--porcelain']).trim().length > 0;
  return { repo: repoPath, branch, sha, dirty, capturedAt: now(), machine };
}

export function resolveAllowedRepos(allowlist: RepoRef[]): RepoRef[] {
  return allowlist; // configured only; tester text can never extend this (Decision #5)
}

// Conservative mapping: an intake's product_hint must match exactly one
// allowlisted repo (case-insensitive substring on the repo name). Zero or
// multiple matches -> needs_scope_review with NO repos (never broaden).
export function classifyScope(
  intake: { product_hint: string | null }, allowlist: RepoRef[]
): { repos: string[]; needsScopeReview: boolean } {
  const hint = (intake.product_hint ?? '').trim().toLowerCase();
  if (!hint) return { repos: [], needsScopeReview: true };
  const matches = allowlist.filter((r) => r.name.toLowerCase().includes(hint));
  if (matches.length === 1) return { repos: [matches[0].name], needsScopeReview: false };
  return { repos: [], needsScopeReview: true };
}
```

Add to `config.ts`: `intakeRepoAllowlist: RepoRef[]` parsed from `INTAKE_REPO_ALLOWLIST` (JSON array of `{name,path}`) — default `[]`. Document in `.env.example` with an example value. (Import the `RepoRef` type or inline the shape.)

- [ ] **Step 4: Run test → pass; commit**

Run: `cd dashboard/server && node --require ts-node/register --test src/local/repoProvenance.test.ts` → PASS. Then `npm test && npm run build`.

```bash
git add dashboard/server/src/local/repoProvenance.ts dashboard/server/src/local/repoProvenance.test.ts dashboard/server/src/intake/config.ts dashboard/server/.env.example
git commit -m "feat(intake-local): allowlist-bounded repo provenance + scope classification"
```

---

## Task 6: Local — bounded triage package export

**Files:**
- Create: `dashboard/server/src/local/triagePackage.ts`
- Create: `dashboard/server/src/local/triagePackage.test.ts`

**Interfaces:**
- Consumes: `captureProvenance`/`classifyScope` (Task 5), `TRIAGE_SCHEMA_VERSION` (Task 3), `intakeConfig`.
- Produces: `buildTriagePackage({ intake, allowlist, provenance, approvedSnippets? }): { manifest, contextHash, promptSchemaVersion }` — the bounded manifest (Decision #10) containing: the intake structured fields + filtered text (NOT raw attachments/images — Decision #7), the selected repo allowlist, exact branch/SHA/dirty provenance, any owner-approved source snippets, the prompt/schema version, and a deterministic `contextHash` over the manifest. It is a DATA package the owner runs manually — this module NEVER spawns an AI process (Decision #10) and never sends attachments to a model. If `classifyScope` returned `needsScopeReview`, `buildTriagePackage` throws (the owner must resolve scope first).

- [ ] **Step 1: Write failing test**

```typescript
// dashboard/server/src/local/triagePackage.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTriagePackage } from './triagePackage';
import { TRIAGE_SCHEMA_VERSION } from '../intake/triageSchema';

const intake = { id: 'INTAKE-1', title: 'Wallet debit fails', body: 'steps', product_hint: 'wallet', state: 'submitted', revision: 1 };
const provenance = [{ repo: '/r/w', branch: 'main', sha: 'deadbeef', dirty: false, capturedAt: 1, machine: 'm1' }];

test('package embeds intake+provenance+schema version and a stable contextHash', () => {
  const pkg = buildTriagePackage({ intake: intake as any, repos: ['Games-Labs-Wallet'], provenance, approvedSnippets: [] });
  assert.equal(pkg.promptSchemaVersion, TRIAGE_SCHEMA_VERSION);
  assert.equal(pkg.manifest.intake.title, 'Wallet debit fails');
  assert.deepEqual(pkg.manifest.provenance, provenance);
  assert.ok(pkg.contextHash.length >= 16);
  // Deterministic: same inputs -> same hash
  const again = buildTriagePackage({ intake: intake as any, repos: ['Games-Labs-Wallet'], provenance, approvedSnippets: [] });
  assert.equal(again.contextHash, pkg.contextHash);
});

test('no raw attachment bytes are ever included', () => {
  const pkg = buildTriagePackage({ intake: intake as any, repos: ['Games-Labs-Wallet'], provenance, approvedSnippets: [] });
  assert.equal(JSON.stringify(pkg.manifest).includes('base64'), false);
  assert.equal((pkg.manifest as any).attachments, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/server && node --require ts-node/register --test src/local/triagePackage.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `triagePackage.ts`**

```typescript
// dashboard/server/src/local/triagePackage.ts
import crypto from 'crypto';
import { TRIAGE_SCHEMA_VERSION } from '../intake/triageSchema';
import type { Provenance } from './repoProvenance';

export interface TriageManifest {
  intake: { id: string; title: string; body: string; productHint: string | null; revision: number };
  repos: string[];
  provenance: Provenance[];
  approvedSnippets: { repo: string; path: string; excerpt: string }[];
  promptSchemaVersion: string;
  expectedResultSchema: string;
}

export function buildTriagePackage(input: {
  intake: { id: string; title: string; body: string; product_hint: string | null; revision: number };
  repos: string[];
  provenance: Provenance[];
  approvedSnippets?: { repo: string; path: string; excerpt: string }[];
}): { manifest: TriageManifest; contextHash: string; promptSchemaVersion: string } {
  if (!input.repos.length) {
    throw new Error('needs_scope_review: cannot build a triage package with no allowlisted repos');
  }
  // DATA only — attachments/images are intentionally excluded (Decision #7/#10).
  const manifest: TriageManifest = {
    intake: {
      id: input.intake.id, title: input.intake.title, body: input.intake.body,
      productHint: input.intake.product_hint, revision: input.intake.revision,
    },
    repos: input.repos,
    provenance: input.provenance,
    approvedSnippets: input.approvedSnippets ?? [],
    promptSchemaVersion: TRIAGE_SCHEMA_VERSION,
    expectedResultSchema: TRIAGE_SCHEMA_VERSION,
  };
  // Stable hash over a canonical JSON serialization (sorted keys).
  const canonical = JSON.stringify(manifest, Object.keys(manifest).sort());
  const contextHash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  return { manifest, contextHash, promptSchemaVersion: TRIAGE_SCHEMA_VERSION };
}
```

- [ ] **Step 4: Run test → pass; commit**

Run: `cd dashboard/server && node --require ts-node/register --test src/local/triagePackage.test.ts` → PASS. Then `npm test && npm run build`.

```bash
git add dashboard/server/src/local/triagePackage.ts dashboard/server/src/local/triagePackage.test.ts
git commit -m "feat(intake-local): bounded manual triage package with context hash"
```

---

## Task 7: Local — triage gate + admin override

**Files:**
- Create: `dashboard/server/src/local/triageGate.ts`
- Create: `dashboard/server/src/local/triageGate.test.ts`

**Interfaces:**
- Produces: `checkPromotionGate({ intakeState, latestTriage, override? }): { allowed: boolean; reason: string; gateOverridden: boolean }` (Decision #11). Default: promotion requires a schema-valid triage whose `classification === 'triaged'`. `needs_scope_review`/`ai_failed`/absent triage ⇒ blocked. An `override = { reason }` with a non-empty reason ⇒ `allowed: true, gateOverridden: true` — but a `reason`-less override never opens the gate, and an override NEVER relabels or repairs a failed triage (Decision #11).

- [ ] **Step 1: Write failing test**

```typescript
// dashboard/server/src/local/triageGate.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPromotionGate } from './triageGate';
import { TRIAGE_SCHEMA_VERSION } from '../intake/triageSchema';

const triaged = { schemaVersion: TRIAGE_SCHEMA_VERSION, classification: 'triaged', summary: 's', contextHash: 'h' };

test('valid triaged result opens the gate without override', () => {
  const r = checkPromotionGate({ intakeState: 'triaged', latestTriage: triaged });
  assert.deepEqual(r, { allowed: true, reason: 'triage_valid', gateOverridden: false });
});

test('missing/failed triage blocks unless a reasoned override is given', () => {
  assert.equal(checkPromotionGate({ intakeState: 'submitted', latestTriage: null }).allowed, false);
  assert.equal(checkPromotionGate({ intakeState: 'ai_failed', latestTriage: { ...triaged, classification: 'ai_failed' } }).allowed, false);
  // reason-less override does NOT open the gate
  assert.equal(checkPromotionGate({ intakeState: 'ai_failed', latestTriage: null, override: { reason: '' } }).allowed, false);
  // reasoned override opens it and flags gateOverridden
  const o = checkPromotionGate({ intakeState: 'ai_failed', latestTriage: null, override: { reason: 'urgent hotfix' } });
  assert.deepEqual(o, { allowed: true, reason: 'gate_overridden', gateOverridden: true });
});
```

- [ ] **Step 2: Run test → fail**

Run: `cd dashboard/server && node --require ts-node/register --test src/local/triageGate.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `triageGate.ts`**

```typescript
// dashboard/server/src/local/triageGate.ts
import { TRIAGE_SCHEMA_VERSION } from '../intake/triageSchema';

export function checkPromotionGate(input: {
  intakeState: string;
  latestTriage: { schemaVersion?: string; classification?: string } | null;
  override?: { reason?: string };
}): { allowed: boolean; reason: string; gateOverridden: boolean } {
  const t = input.latestTriage;
  const triageValid = !!t && t.schemaVersion === TRIAGE_SCHEMA_VERSION && t.classification === 'triaged';
  if (triageValid) return { allowed: true, reason: 'triage_valid', gateOverridden: false };

  const reason = (input.override?.reason ?? '').trim();
  if (reason) return { allowed: true, reason: 'gate_overridden', gateOverridden: true };

  return { allowed: false, reason: 'triage_required', gateOverridden: false };
}
```

- [ ] **Step 4: Run test → pass; commit**

Run: `cd dashboard/server && node --require ts-node/register --test src/local/triageGate.test.ts` → PASS. Then `npm test`.

```bash
git add dashboard/server/src/local/triageGate.ts dashboard/server/src/local/triageGate.test.ts
git commit -m "feat(intake-local): promotion triage gate with reasoned override"
```

---

## Task 8: Local — redacted, collision-safe promotion into `runs/<TASK-ID>`

**Files:**
- Create: `dashboard/server/src/local/promotionProjection.ts`
- Create: `dashboard/server/src/local/promotionProjection.test.ts`
- Create: `dashboard/server/src/local/promotion.ts`
- Create: `dashboard/server/src/local/promotion.test.ts`

**Interfaces:**
- Consumes: `checkPromotionGate` (Task 7), `config` (`runsDir`, task prefix resolution), the existing `pathSecurity.TASK_ID_PATTERN`, `ruby validate-yaml.rb`.
- Produces:
  - `promotionProjection.ts`: `PROMOTION_PROJECTION_VERSION = 'promo.v1'`; `projectIntakeForPromotion({ intake, triage }): PromotedProjection` — the Decision-#12 allowlist ONLY (Central Intake ID + authorized link, sanitized title/summary, product/service/repo scope, repro steps, expected/actual, env/build, severity/priority, acceptance/open questions, triage summary/risk flags/duplicate refs, pseudonymous reporter ref). It NEVER includes access codes, sessions/tokens, IP/UA/email, raw attachments/logs, full AI prompt/context/source snippets, detected secrets, or tester real name. `assertNoForbiddenFields(projection)` throws if a forbidden key is present (defense-in-depth before writing to team-synced `runs/`).
  - `promotion.ts`: `promoteIntake({ intake, triage, gate, owner, taskPrefix, runsDir, now, validate?, central? }): Promise<{ ok: true; taskId } | { ok: false; reason }>` —
    1. Re-check the gate (`checkPromotionGate`); a blocked gate without a reasoned override aborts.
    2. Allocate a **collision-safe** `TASK-<PREFIX>-NNN`: scan existing `runs/` for the max NNN in the prefix namespace, then create the run dir with **exclusive** `fs.mkdir(dir)` (NOT recursive — fails if it exists); on `EEXIST`, increment and retry (bounded). This closes the `max()+1` race the M1/original review flagged.
    3. Build the redacted projection; run `assertNoForbiddenFields`.
    4. Write `task.md` (human-readable scope from the projection) + a minimal valid `status.yaml` (`task_id`, `phase: pending`, `state: pending`, `iteration: 0`, `current_agent: null`, `created_at`) using atomic tmp+fsync+rename.
    5. Run `ruby validate-yaml.rb <taskId>` (injectable `validate` for tests); on failure, **roll back** (remove the run dir) and return `{ ok: false, reason: 'validation_failed' }`.
    6. Record the Intake→TASK relationship on Central via `central.recordPromotion` (injectable); include `projectionVersion`, `gateOverridden`, and repo provenance in the promotion audit (Decision #12).
    7. Idempotent: if this intake was already promoted (a recorded relationship / an existing run for it), return the existing `taskId` without creating a second run. NEVER invoke PM, dispatch, or `run-agent.sh <id> <role>` (Decision #6).

- [ ] **Step 1: Write failing projection test**

```typescript
// dashboard/server/src/local/promotionProjection.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectIntakeForPromotion, assertNoForbiddenFields, PROMOTION_PROJECTION_VERSION } from './promotionProjection';

const intake = {
  id: 'INTAKE-1', title: 'Wallet debit fails', body: 'repro steps', product_hint: 'wallet',
  tester_id: 'TSTR-secret', // must NOT leak
};
const triage = { schemaVersion: 'triage.v1', classification: 'triaged', summary: 'debit path bug', riskFlags: ['money'], duplicateCandidates: ['INTAKE-0'], contextHash: 'h' };

test('projection includes allowed fields and excludes identity/secrets', () => {
  const p = projectIntakeForPromotion({ intake: intake as any, triage: triage as any });
  assert.equal(p.projectionVersion, PROMOTION_PROJECTION_VERSION);
  assert.equal(p.centralIntakeId, 'INTAKE-1');
  assert.equal(p.title, 'Wallet debit fails');
  assert.equal(p.triageSummary, 'debit path bug');
  assert.deepEqual(p.riskFlags, ['money']);
  // forbidden identity fields absent
  assert.equal((p as any).tester_id, undefined);
  assert.equal((p as any).testerRealName, undefined);
  assertNoForbiddenFields(p); // does not throw
});

test('assertNoForbiddenFields throws if a forbidden key sneaks in', () => {
  assert.throws(() => assertNoForbiddenFields({ ...({} as any), accessCode: 'x' }));
});
```

- [ ] **Step 2: Run test → fail**

Run: `cd dashboard/server && node --require ts-node/register --test src/local/promotionProjection.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `promotionProjection.ts`**

```typescript
// dashboard/server/src/local/promotionProjection.ts
export const PROMOTION_PROJECTION_VERSION = 'promo.v1';

export interface PromotedProjection {
  projectionVersion: string;
  centralIntakeId: string;
  title: string;
  summary: string;
  productScope: string | null;
  reproSteps: string;
  triageSummary: string | null;
  riskFlags: string[];
  duplicateRefs: string[];
  reporterRef: string; // pseudonymous, NOT the tester real name / id
}

const FORBIDDEN_KEYS = [
  'accessCode', 'access_code', 'session', 'token', 'ip', 'userAgent', 'user_agent',
  'email', 'testerRealName', 'tester_id', 'attachments', 'rawLog', 'prompt', 'contextManifest',
  'sourceSnippet', 'secret', 'credential',
];

export function projectIntakeForPromotion(input: {
  intake: { id: string; title: string; body: string; product_hint: string | null; tester_id: string };
  triage: { summary?: string; riskFlags?: string[]; duplicateCandidates?: string[] } | null;
}): PromotedProjection {
  // pseudonymous, stable-per-intake reporter reference (no real identity)
  const reporterRef = `reporter:${input.intake.id}`;
  return {
    projectionVersion: PROMOTION_PROJECTION_VERSION,
    centralIntakeId: input.intake.id,
    title: input.intake.title,
    summary: input.intake.body.slice(0, 2000),
    productScope: input.intake.product_hint,
    reproSteps: input.intake.body,
    triageSummary: input.triage?.summary ?? null,
    riskFlags: input.triage?.riskFlags ?? [],
    duplicateRefs: input.triage?.duplicateCandidates ?? [],
    reporterRef,
  };
}

export function assertNoForbiddenFields(projection: object): void {
  const keys = new Set(Object.keys(projection));
  for (const forbidden of FORBIDDEN_KEYS) {
    if (keys.has(forbidden)) throw new Error(`promotion projection leaks forbidden field: ${forbidden}`);
  }
}
```

- [ ] **Step 4: Run projection test → pass**

Run: `cd dashboard/server && node --require ts-node/register --test src/local/promotionProjection.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing promotion test** (injected validate + central; temp runs dir)

```typescript
// dashboard/server/src/local/promotion.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { promoteIntake } from './promotion';

function tmpRuns() { return fs.mkdtempSync(path.join(os.tmpdir(), 'runs-')); }
const intake = { id: 'INTAKE-1', title: 'Wallet debit fails', body: 'repro', product_hint: 'wallet', tester_id: 'TSTR-x', revision: 2 };
const triage = { schemaVersion: 'triage.v1', classification: 'triaged', summary: 's', contextHash: 'h' };
const gate = { allowed: true, reason: 'triage_valid', gateOverridden: false };

test('promotes to a collision-safe TASK id with a valid pending status.yaml and records the relationship', async () => {
  const runsDir = tmpRuns();
  const recorded: any[] = [];
  const r = await promoteIntake({
    intake: intake as any, triage: triage as any, gate, owner: 'earth', taskPrefix: 'EAR',
    runsDir, now: () => 1700, validate: async () => ({ ok: true }),
    central: { recordPromotion: async (id, body) => { recorded.push({ id, body }); } } as any,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.taskId, /^TASK-EAR-\d+$/);
    const status = fs.readFileSync(path.join(runsDir, r.taskId, 'status.yaml'), 'utf8');
    assert.match(status, /phase: pending/);
    assert.match(status, /current_agent:\s*(null|~)?/);
    assert.ok(fs.existsSync(path.join(runsDir, r.taskId, 'task.md')));
    assert.equal(recorded[0].body.projectionVersion, 'promo.v1');
    // task.md must NOT contain the tester id
    assert.equal(fs.readFileSync(path.join(runsDir, r.taskId, 'task.md'), 'utf8').includes('TSTR-x'), false);
  }
});

test('validation failure rolls back the run dir', async () => {
  const runsDir = tmpRuns();
  const r = await promoteIntake({
    intake: intake as any, triage: triage as any, gate, owner: 'earth', taskPrefix: 'EAR',
    runsDir, now: () => 1700, validate: async () => ({ ok: false, error: 'bad' }),
    central: { recordPromotion: async () => {} } as any,
  });
  assert.equal(r.ok, false);
  // no leftover run dir
  assert.equal(fs.readdirSync(runsDir).length, 0);
});

test('blocked gate without override aborts', async () => {
  const runsDir = tmpRuns();
  const r = await promoteIntake({
    intake: intake as any, triage: null as any,
    gate: { allowed: false, reason: 'triage_required', gateOverridden: false },
    owner: 'earth', taskPrefix: 'EAR', runsDir, now: () => 1, validate: async () => ({ ok: true }),
    central: { recordPromotion: async () => {} } as any,
  });
  assert.equal(r.ok, false);
});
```

- [ ] **Step 6: Run test → fail**

Run: `cd dashboard/server && node --require ts-node/register --test src/local/promotion.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 7: Implement `promotion.ts`**

```typescript
// dashboard/server/src/local/promotion.ts
import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import { projectIntakeForPromotion, assertNoForbiddenFields, PromotedProjection } from './promotionProjection';

const TASK_NUM = /^TASK-[A-Z][A-Z0-9]*-(\d+)$/;

async function nextTaskNumber(runsDir: string, prefix: string): Promise<number> {
  let max = 0;
  try {
    for (const entry of await fs.readdir(runsDir)) {
      const m = entry.match(new RegExp(`^TASK-${prefix}-(\\d+)$`));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch { /* dir may not exist yet */ }
  return max + 1;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  const handle = await fs.open(tmp, 'w');
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(tmp, filePath);
}

function renderTaskMd(taskId: string, p: PromotedProjection): string {
  return [
    `# ${taskId} — ${p.title}`, '',
    `> Promoted from Central Intake ${p.centralIntakeId} (projection ${p.projectionVersion}).`,
    `> Reporter: ${p.reporterRef}`, '',
    '## Summary', p.summary, '',
    '## Product scope', p.productScope ?? '(unassigned — set during PM)', '',
    '## Reproduction', p.reproSteps, '',
    '## Triage', p.triageSummary ?? '(none)',
    p.riskFlags.length ? `\nRisk flags: ${p.riskFlags.join(', ')}` : '',
    p.duplicateRefs.length ? `Duplicate candidates: ${p.duplicateRefs.join(', ')}` : '',
  ].join('\n');
}

function renderStatusYaml(taskId: string, now: number): string {
  // Minimal VALID status.yaml per validate-yaml.rb:125 — current_agent null, phase pending.
  return yaml.dump({
    task_id: taskId, phase: 'pending', state: 'pending', iteration: 0,
    current_agent: null, created_at: new Date(now).toISOString(),
  });
}

export interface PromoteDeps {
  validate?: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
  central?: { recordPromotion: (intakeId: string, body: object) => Promise<void> };
}

export async function promoteIntake(input: {
  intake: { id: string; title: string; body: string; product_hint: string | null; tester_id: string; revision: number };
  triage: { summary?: string; riskFlags?: string[]; duplicateCandidates?: string[] } | null;
  gate: { allowed: boolean; gateOverridden: boolean };
  owner: string; taskPrefix: string; runsDir: string; now: () => number;
} & PromoteDeps): Promise<{ ok: true; taskId: string } | { ok: false; reason: string }> {
  if (!input.gate.allowed) return { ok: false, reason: 'gate_blocked' };

  const projection = projectIntakeForPromotion({ intake: input.intake, triage: input.triage });
  assertNoForbiddenFields(projection); // defense-in-depth before writing team-synced runs/

  // Collision-safe allocation: exclusive mkdir, retry on EEXIST.
  let taskId = '';
  let runDir = '';
  for (let attempt = 0; attempt < 50; attempt++) {
    const n = await nextTaskNumber(input.runsDir, input.taskPrefix);
    taskId = `TASK-${input.taskPrefix}-${String(n).padStart(3, '0')}`;
    runDir = path.join(input.runsDir, taskId);
    try {
      await fs.mkdir(runDir, { recursive: false }); // NOT recursive → throws EEXIST on a race
      break;
    } catch (e: any) {
      if (e.code === 'EEXIST') { taskId = ''; continue; }
      throw e;
    }
  }
  if (!taskId) return { ok: false, reason: 'id_allocation_failed' };

  try {
    await atomicWrite(path.join(runDir, 'task.md'), renderTaskMd(taskId, projection));
    await atomicWrite(path.join(runDir, 'status.yaml'), renderStatusYaml(taskId, input.now()));

    const validate = input.validate ?? (async () => ({ ok: true }));
    const v = await validate(taskId);
    if (!v.ok) {
      await fs.rm(runDir, { recursive: true, force: true }); // roll back
      return { ok: false, reason: 'validation_failed' };
    }

    if (input.central) {
      await input.central.recordPromotion(input.intake.id, {
        taskId, projectionVersion: projection.projectionVersion,
        gateOverridden: input.gate.gateOverridden, projection,
      });
    }
    return { ok: true, taskId };
  } catch (e) {
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, reason: 'promotion_error' };
  }
}
```

Note (idempotency): the test set covers allocation, rollback, and gate-abort. Full idempotency (re-promoting an already-promoted intake returns the existing `taskId`) is enforced on the **Central** side by recording the Intake→TASK relationship and rejecting a second `recordPromotion` for the same intake — add that guard when wiring the Central promotion-record endpoint (a follow-up sub-task in the route-wiring step below; the `central.recordPromotion` stub here is where it plugs in).

- [ ] **Step 8: Run promotion tests → pass**

Run: `cd dashboard/server && node --require ts-node/register --test src/local/promotion.test.ts`
Expected: PASS (all three). Then `cd dashboard/server && npm test && npm run build` → full suite green, tsc clean.

- [ ] **Step 9: Commit**

```bash
git add dashboard/server/src/local/promotionProjection.ts dashboard/server/src/local/promotionProjection.test.ts dashboard/server/src/local/promotion.ts dashboard/server/src/local/promotion.test.ts
git commit -m "feat(intake-local): redacted collision-safe promotion into runs/ (no dispatch)"
```

---

## Task 9: Wire Local admin routes + Central promotion-record endpoint (keystone)

**Files:**
- Modify: `dashboard/server/src/intake/migrations.ts` (append migration `version: 3` — `promotion` relationship table)
- Create: `dashboard/server/src/intake/promotionRecordStore.ts`
- Create: `dashboard/server/src/intake/promotionRecordStore.test.ts`
- Create: `dashboard/server/src/routes/intake/promotion.ts` (Central relationship endpoint)
- Create: `dashboard/server/src/routes/local/index.ts` (Local admin routes)
- Create: `dashboard/server/src/routes/local/local.integration.test.ts`
- Modify: `dashboard/server/src/routes/intake/index.ts` (mount Central promotion endpoint)
- Modify: `dashboard/server/src/index.ts` (mount the Local admin routes by deployment role)
- Modify: `dashboard/server/src/intake/config.ts` (add `intakeRole`, `syncCursorPath`)

**Interfaces:**
- Consumes: everything from Tasks 1–8 (`makeCentralClient`, `readCursor`/`writeCursor`, `captureProvenance`/`classifyScope`/`resolveAllowedRepos`, `buildTriagePackage`, `checkPromotionGate`, `promoteIntake`, `getLatestTriage`), plus the admin bearer guard and `recordAudit`.
- Produces:
  - Migration `version: 3`: `promotion(id, intake_id UNIQUE, task_id, projection_version, gate_overridden, created_at)` — the `UNIQUE(intake_id)` constraint is the idempotency backstop.
  - `promotionRecordStore.ts`: `recordPromotion(db, { intakeId, taskId, projectionVersion, gateOverridden }): { created: boolean; taskId }` — inserts the relationship; if `intake_id` already has a promotion, returns the existing `taskId` with `created: false` (idempotent — a retried/double promote never mints a second TASK). Also transitions the intake to `promoted` via `setIntakeState` on first record. `getPromotion(db, intakeId)`.
  - Central route (admin-bearer): `POST /api/intake/intakes/:id/promotion` → 201 (new) | 200 (already promoted, returns existing taskId). This is the endpoint `promotion.ts`'s `central.recordPromotion` (Task 8) targets.
  - Local admin routes (mounted only when `intakeRole` includes `local`), all admin-bearer-guarded, each composing tested units and reaching Central **only** through `makeCentralClient` (Local never opens Central SQLite — Decision #1):
    - `POST /api/local/refresh` → pull `getChanges(cursor)` from Central, persist the new cursor (`writeCursor`), return the deltas. Read-only (Decision #14).
    - `POST /api/local/intakes/:id/claim` | `/renew` | `/release` → proxy to Central claim endpoints via the client.
    - `POST /api/local/intakes/:id/triage-package` → `resolveAllowedRepos` + `classifyScope`; if `needsScopeReview`, set the intake to `needs_scope_review` on Central and return `{ needsScopeReview: true }`; else `captureProvenance` per repo + `buildTriagePackage` and return the manifest + contextHash for the owner to run manually.
    - `POST /api/local/intakes/:id/triage-result` → `importTriage` on Central (Central validates the schema; Local just forwards + records importer).
    - `POST /api/local/intakes/:id/promote` → fetch the intake + `getLatestTriage` (via Central), `checkPromotionGate`, `promoteIntake({ ..., central: { recordPromotion: (id,body) => client.recordPromotion(id, body) } })`, return `{ taskId }` or the gate/validation failure.

- [ ] **Step 1: Write the failing promotion-record store test**

```typescript
// dashboard/server/src/intake/promotionRecordStore.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { submitIntake, getIntake } from './intakeStore';
import { recordPromotion, getPromotion } from './promotionRecordStore';

function seed(db: any) {
  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)').run('t1', 'T', 1);
  return submitIntake(db, { testerId: 't1', title: 'A', body: 'x' }).intake;
}

test('first record creates the relationship and marks the intake promoted; second is idempotent', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const intake = seed(db);
  const a = recordPromotion(db, { intakeId: intake.id, taskId: 'TASK-EAR-007', projectionVersion: 'promo.v1', gateOverridden: false });
  assert.deepEqual(a, { created: true, taskId: 'TASK-EAR-007' });
  assert.equal(getIntake(db, intake.id)!.state, 'promoted');

  // A second promote for the same intake returns the ORIGINAL task id, no new row.
  const b = recordPromotion(db, { intakeId: intake.id, taskId: 'TASK-EAR-999', projectionVersion: 'promo.v1', gateOverridden: false });
  assert.deepEqual(b, { created: false, taskId: 'TASK-EAR-007' });
  assert.equal((db.prepare('SELECT COUNT(*) c FROM promotion').get() as any).c, 1);
  assert.equal(getPromotion(db, intake.id)!.task_id, 'TASK-EAR-007');
});
```

- [ ] **Step 2: Run test → fail**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/promotionRecordStore.test.ts`
Expected: FAIL — migration lacks `promotion`, module missing.

- [ ] **Step 3: Append migration v3 + implement the store**

In `migrations.ts` add to `MIGRATIONS`:

```typescript
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
```

```typescript
// dashboard/server/src/intake/promotionRecordStore.ts
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

export function recordPromotion(
  db: DB,
  input: { intakeId: string; taskId: string; projectionVersion: string; gateOverridden: boolean }
): { created: boolean; taskId: string } {
  const existing = getPromotion(db, input.intakeId);
  if (existing) return { created: false, taskId: existing.task_id }; // idempotent

  db.prepare(
    'INSERT INTO promotion(id,intake_id,task_id,projection_version,gate_overridden,created_at) VALUES(?,?,?,?,?,?)'
  ).run(randomId('PROMO'), input.intakeId, input.taskId, input.projectionVersion, input.gateOverridden ? 1 : 0, Date.now());

  const intake = getIntake(db, input.intakeId);
  if (intake && intake.state !== 'promoted') setIntakeState(db, input.intakeId, intake.revision, 'promoted');
  recordAudit(db, {
    kind: 'intake_promoted', actorKind: 'admin', intakeId: input.intakeId,
    detail: { taskId: input.taskId, projectionVersion: input.projectionVersion, gateOverridden: input.gateOverridden },
  });
  return { created: true, taskId: input.taskId };
}
```

- [ ] **Step 4: Run store test → pass**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/promotionRecordStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Central promotion route + mount**

```typescript
// dashboard/server/src/routes/intake/promotion.ts
import { Router, json } from 'express';
import type { DB } from '../../intake/db';
import { recordPromotion } from '../../intake/promotionRecordStore';
import { createAuthMiddleware } from '../../middleware/auth';

export function buildPromotionRouter(db: DB, adminToken: string | undefined): Router {
  const router = Router({ mergeParams: true });
  router.use(createAuthMiddleware(adminToken), json({ limit: '256kb' }));
  router.post('/', (req, res) => {
    const r = recordPromotion(db, {
      intakeId: req.params.id, taskId: String(req.body?.taskId ?? '').trim(),
      projectionVersion: String(req.body?.projectionVersion ?? '').trim(), gateOverridden: !!req.body?.gateOverridden,
    });
    res.status(r.created ? 201 : 200).json(r);
  });
  return router;
}
```

Mount in `routes/intake/index.ts`: `app.use('/api/intake/intakes/:id/promotion', buildPromotionRouter(db, opts.adminToken));`

- [ ] **Step 6: Config — `intakeRole` + `syncCursorPath`**

In `config.ts` add: `intakeRole: (env.INTAKE_ROLE || 'both').trim()` (`'central' | 'local' | 'both'` `[PLAN-ASSUMPTION]`) and `syncCursorPath: (env.INTAKE_SYNC_CURSOR_PATH || path.join(dataDir, 'sync-cursor.json')).trim()`. Document both in `.env.example`. (The changes/claim/triage/promotion Central routers already mount unconditionally in the intake tree; they are harmless on a Local-only node since Local won't call its own Central endpoints — but for cleanliness, gate their mount on `intakeRole !== 'local'` in a follow-up if desired. `[PLAN-ASSUMPTION]`: leaving them mounted is acceptable for M2.)

- [ ] **Step 7: Local admin routes**

```typescript
// dashboard/server/src/routes/local/index.ts
import { Router, json, type Express } from 'express';
import type { DB } from '../../intake/db';
import { getDb } from '../../intake/db';
import { intakeConfig } from '../../intake/config';
import { makeCentralClient } from '../../local/centralClient';
import { readCursor, writeCursor } from '../../local/syncCursor';
import { resolveAllowedRepos, classifyScope, captureProvenance } from '../../local/repoProvenance';
import { buildTriagePackage } from '../../local/triagePackage';
import { checkPromotionGate } from '../../local/triageGate';
import { promoteIntake } from '../../local/promotion';
import { createAuthMiddleware } from '../../middleware/auth';

// Deps are injectable so the integration test can stub Central + fs + validate.
export interface LocalDeps {
  db?: DB;
  client?: ReturnType<typeof makeCentralClient>;
  cursorPath?: string;
  runsDir?: string;
  taskPrefix?: string;
  validate?: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
  now?: () => number;
}

export function buildLocalRouter(adminToken: string | undefined, deps: LocalDeps = {}): Router {
  const db = deps.db ?? getDb();
  const client = deps.client ?? makeCentralClient({ baseUrl: intakeConfig.centralBaseUrl, adminToken: adminToken ?? '' });
  const cursorPath = deps.cursorPath ?? intakeConfig.syncCursorPath;
  const runsDir = deps.runsDir ?? intakeConfig.runsDir;
  const now = deps.now ?? (() => Date.now());

  const router = Router();
  router.use(createAuthMiddleware(adminToken), json({ limit: '512kb' }));

  router.post('/refresh', async (_req, res) => {
    const cursor = await readCursor(cursorPath);
    const { changes, nextCursor } = await client.getChanges(cursor);
    if (nextCursor > cursor) await writeCursor(cursorPath, nextCursor);
    res.json({ changes, cursor: nextCursor });
  });

  router.post('/intakes/:id/claim', async (req, res) =>
    res.json(await client.claim(req.params.id, String(req.body?.owner ?? ''), Number(req.body?.expectedRevision))));

  router.post('/intakes/:id/triage-package', async (req, res) => {
    const intake = req.body?.intake; // owner supplies the claimed intake snapshot from a prior refresh/detail
    const scope = classifyScope(intake, resolveAllowedRepos(intakeConfig.intakeRepoAllowlist));
    if (scope.needsScopeReview) { res.json({ needsScopeReview: true }); return; }
    const provenance = scope.repos
      .map((name) => intakeConfig.intakeRepoAllowlist.find((r) => r.name === name))
      .filter(Boolean)
      .map((r: any) => captureProvenance(r.path, undefined, now, intakeConfig.localMachineId));
    const pkg = buildTriagePackage({ intake, repos: scope.repos, provenance });
    res.json(pkg);
  });

  router.post('/intakes/:id/triage-result', async (req, res) =>
    res.json(await client.importTriage(req.params.id, req.body)));

  router.post('/intakes/:id/promote', async (req, res) => {
    const { intake, triage, override } = req.body ?? {};
    const gate = checkPromotionGate({ intakeState: intake?.state, latestTriage: triage ?? null, override });
    const result = await promoteIntake({
      intake, triage: triage ?? null, gate, owner: String(req.body?.owner ?? ''),
      taskPrefix: deps.taskPrefix ?? String(req.body?.taskPrefix ?? '').trim(),
      runsDir, now, validate: deps.validate,
      central: { recordPromotion: (id, body) => client.recordPromotion(id, body).then(() => undefined) },
    });
    res.status(result.ok ? 201 : 409).json(result);
  });

  return router;
}

export function mountLocalRoutes(app: Express, adminToken: string | undefined, deps: LocalDeps = {}): void {
  app.use('/api/local', buildLocalRouter(adminToken, deps));
}
```

- [ ] **Step 8: Integration test** (in-process Central app + a client pointed at it; stub validate + runs dir)

```typescript
// dashboard/server/src/routes/local/local.integration.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { openDb } from '../../intake/db';
import { runMigrations } from '../../intake/migrations';
import { submitIntake } from '../../intake/intakeStore';
import { mountIntakeRoutes } from '../intake';
import { makeCentralClient } from '../../local/centralClient';
import { mountLocalRoutes } from './index';

async function listen(app: any) {
  const { createServer } = await import('http');
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  return { server, port: (server.address() as any).port };
}

test('Local refresh pulls Central changes and advances the cursor', async () => {
  const db = openDb(':memory:'); runMigrations(db);
  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)').run('t1', 'T', 1);
  submitIntake(db, { testerId: 't1', title: 'A', body: 'x' });

  const central = express();
  mountIntakeRoutes(central, { db, allowedOrigins: ['https://intake.lan'], adminToken: 'admin-secret' });
  const { server, port } = await listen(central);

  const client = makeCentralClient({ baseUrl: `http://127.0.0.1:${port}`, adminToken: 'admin-secret' });
  const cursorPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-')), 'cursor.json');
  const local = express();
  mountLocalRoutes(local, 'admin-secret', { db, client, cursorPath, runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'r-')), taskPrefix: 'EAR', validate: async () => ({ ok: true }), now: () => 1 });
  const { server: ls, port: lport } = await listen(local);

  const res = await fetch(`http://127.0.0.1:${lport}/api/local/refresh`, { method: 'POST', headers: { authorization: 'Bearer admin-secret' } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.changes.length, 1);
  assert.ok(body.cursor > 0);
  assert.equal(JSON.parse(fs.readFileSync(cursorPath, 'utf8')).seq, body.cursor);
  server.close(); ls.close();
});
```

- [ ] **Step 9: Mount Local routes in index.ts by role + run everything**

In `dashboard/server/src/index.ts`, after `mountIntakeRoutes(...)` (and before the bearer guard), add:

```typescript
import { mountLocalRoutes } from './routes/local';
import { intakeConfig } from './intake/config';
// ...
if (intakeConfig.intakeRole === 'local' || intakeConfig.intakeRole === 'both') {
  mountLocalRoutes(app, config.authToken, { taskPrefix: process.env.OFFICE_TASK_PREFIX });
}
```

Run: `cd dashboard/server && npm test && npm run build`
Expected: full suite green (all M1 + M2 tasks), tsc clean.

- [ ] **Step 10: Commit**

```bash
git add dashboard/server/src/intake/migrations.ts dashboard/server/src/intake/promotionRecordStore.ts dashboard/server/src/intake/promotionRecordStore.test.ts dashboard/server/src/routes/intake/promotion.ts dashboard/server/src/routes/intake/index.ts dashboard/server/src/routes/local/index.ts dashboard/server/src/routes/local/local.integration.test.ts dashboard/server/src/index.ts dashboard/server/src/intake/config.ts dashboard/server/.env.example
git commit -m "feat(intake): wire Local admin routes + idempotent Central promotion-record endpoint"
```

---

## Milestone 2 Definition of Done

- Local pulls Central intake changes over HTTPS with the admin credential and a durable cursor; refresh is read-only and fetches only newer-than-cursor changes.
- The owner claims an intake (revision-aware); a second claim is rejected until TTL expiry; renew/release are owner-scoped; revision conflicts return 409.
- Triage runs against a system-selected repo allowlist only; tester text cannot expand scope; ambiguous/empty scope stops at `needs_scope_review`; provenance (repo/branch/SHA/dirty/timestamp/machine) is captured without mutating any repo.
- The bounded triage package embeds intake + provenance + prompt/schema version + a deterministic context hash, and never includes raw attachments; the owner runs it manually (no background executor).
- The triage result is imported only through the versioned schema; invalid content is never treated as valid; the intake transitions to `triaged | needs_scope_review | ai_failed`; the importer/provider/context-hash/provenance are audited.
- Promotion is gated on a valid triage (or a reasoned admin override that records `triage_gate_overridden: true`), produces a collision-safe `TASK-<PREFIX>-NNN`, writes a redacted `task.md` + a validator-passing minimal `status.yaml` at `phase: pending`, rolls back on validation failure, records the Intake→TASK relationship, and never invokes PM or dispatches a role.
- No tester PII/secret can reach the team-synced `runs/` projection (`assertNoForbiddenFields` + the Decision-#12 allowlist).
- `npm test` and `npm run build` green; `validate-yaml.rb` passes for a promoted TASK.

## Deferred to Milestone 3 (LAN-release hardening)

TLS/reverse proxy + cert trust (the M1 `Secure` cookie prerequisite), retention/deletion jobs, SQLite-consistent backup/restore, a real admin credential + capability set (replacing the M1 bearer-token shim — note the M2 admin endpoints inherit that shim and the "admin-open-when-token-unset" posture; hardening those is M3), storage high-water enforcement, the admin-guard-reads-Authorization-header-only fix, and end-to-end cross-machine failure/recovery + abuse verification. The automatic `Run Triage` executor and periodic polling remain deferred control phases (they must reuse this same schema, cursor, and provenance contract without data migration — Decision #10/#14).

## Self-Review

**Decision coverage (M2 subset):** #5 AI source scope/allowlist → Task 5 (`classifyScope` stops at needs_scope_review; allowlist-only); #6 promotion no-dispatch → Task 8 (never calls run-agent.sh/PM); #9 repo authority/provenance → Task 5 (`captureProvenance`, no pull/reset); #10 manual triage package + versioned schema + provenance audit → Tasks 3, 6 (no background executor); #11 triage gate + reasoned override, invalid-never-valid → Tasks 3, 7; #12 redacted versioned projection → Task 8 (`promotionProjection` allowlist + `assertNoForbiddenFields`); #14 cursor pull read-only + claim TTL + revision conflict → Tasks 1, 2, 4. Central-side single-writer/atomic invariants inherited from M1.

**Placeholder scan:** No "TBD"/"add validation" — every code step has complete code. The one forward-reference (Central promotion-record endpoint enforcing idempotency) is explicitly called out in Task 8's note as a wiring sub-task with its plug point named, not left implicit.

**Type consistency:** `IntakeChange`/`change_seq` (Task 1) consumed by Task 4's client; `ClaimRow` shape (Task 2) matches the claim route; `TriageResult`/`TRIAGE_SCHEMA_VERSION` (Task 3) reused by Tasks 6/7; `Provenance` (Task 5) consumed by Task 6's manifest; `PromotedProjection`/`PROMOTION_PROJECTION_VERSION` (Task 8) consistent across projection and promotion. `setIntakeState` revision semantics (Task 3) align with the claim revision checks (Task 2). Minimal `status.yaml` shape matches `validate-yaml.rb:125` exactly (task_id/phase/iteration/current_agent, state==phase).

**Wiring keystone (Task 9):** the Local admin routes (`routes/local/*`) that expose refresh/claim/triage-package/triage-result/promote to the owner's dashboard, and the Central `POST /api/intake/intakes/:id/promotion` relationship-record endpoint (with its `UNIQUE(intake_id)` idempotency guard and the `promoted` state transition), are covered by **Task 9** — the M2 keystone that composes the Task 1–8 units, analogous to M1's Task 11. Build order: Tasks 1–3 (Central) → 4–8 (Local units) → 9 (wire together).

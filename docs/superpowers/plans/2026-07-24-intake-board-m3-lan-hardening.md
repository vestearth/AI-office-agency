# AI Dev Office Intake Board — Milestone 3 (LAN-release Hardening) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement the code tasks (Phase A) task-by-task. Phase B tasks are infra/ops procedures with acceptance checks, not TDD units. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Harden the completed Intake Board (M1 Central foundation + M2 Local workflow) for real tester use on the office LAN: a real hashed admin credential + capability model replacing the plaintext shared-token shim, retention/deletion sweeps, storage high-water enforcement, throttled-session visibility, SQLite-consistent backup + tested restore, and the TLS reverse proxy + cross-machine verification that make the LAN-facing tester surface actually safe to open.

**Architecture:** No new services. Phase A adds app code to the existing `ai-dev-office/dashboard` Express/TypeScript backend (admin-credential store, a retention sweeper, storage-cap enforcement in the attachment path, an admin read endpoint, a backup module + CLI). Phase B is infrastructure and verification: a TLS-terminating reverse proxy in front of the Central service on `192.168.1.140`, an internal hostname + cert trust, and an end-to-end security/abuse/failure-recovery verification pass.

**Tech Stack:** Node.js + Express 4 + TypeScript, `better-sqlite3` (incl. its online `db.backup()` API), Node built-in `crypto`/`fs`. Reverse proxy: Caddy (auto-HTTPS with an internal CA) `[PLAN-ASSUMPTION]`, nginx alternative documented. Tests: Node's built-in test runner (`node --require ts-node/register --test`).

## ⚠️ Execution environment split (READ FIRST)

This plan is written to be **authored and mostly built off-site**. Each task is tagged:

- **`[anywhere]`** — buildable and unit-testable on any machine (temp dirs / in-memory SQLite, no office LAN, no Central machine). **Phase A (Tasks 1–5) are all `[anywhere]`.**
- **`[office-LAN]`** — can be *planned* now but can only be *executed and verified* on the office LAN / against the Central machine at `192.168.1.140` (the operator is currently off that LAN). **Phase B (Tasks 6–7) are `[office-LAN]`.**

Do Phase A now. Defer Phase B execution until the operator is back on the office LAN (or has another route to the Central host). Phase A ships real security value on its own (a real admin credential, retention, storage caps, tested backup) and does not require the proxy to be built.

## Global Constraints

- **Repo scope:** all app changes under `ai-dev-office/dashboard/`; proxy/infra config + docs under `ai-dev-office/dashboard/deploy/` (new). Meta/tooling repo — **no `TASK-` run**, no `status.yaml` of a run touched, no `knowledge-base/` edits.
- **Backward-compatible with M1/M2:** the admin-credential upgrade must not break the Local→Central client (the client presents a bearer credential today; after T1 it presents a *real hashed* admin credential the same way). No migration of intake/promotion data.
- **Migrations idempotent under boot-replay** (this repo replays all migrations every boot): any new migration uses `IF NOT EXISTS` and appends a new version; never edit versions 1–3.
- **Server-derived audit** for every destructive action (retention deletion, admin credential change, backup, attachment purge) — timestamp/actor from the server, never client-supplied (reuse `intake/audit.ts`).
- **Never block tester submissions on an ops failure** (Decision #7/#13): a failed backup or a retention error surfaces as an *admin warning*, it does not 500 the tester intake path.
- **Secrets never in git or logs:** admin credentials stored only as scrypt hashes (reuse `intake/crypto.ts`); raw credentials shown once at provisioning; backups never contain raw access codes or admin credentials in plaintext beyond their existing hashed columns; the data/backup dirs stay gitignored (`.intake-smoke/`, `intake-data/` already covered — add the backup dir if it lands elsewhere).
- **No state-changing GET** (Decision #3) — any new admin mutation is POST/DELETE, CSRF/credential-guarded.
- **Node test runner only.** Tests for Phase A use temp dirs (`fs.mkdtempSync`) / in-memory DB — **never** the real repo-root `runs/` or a real `intake-data/`.
- **Path-scoped commits** — never `git add .`; unrelated untracked `runs/TASK-EAR-*` dirs exist.
- **`[PLAN-ASSUMPTION]`** marks choices beyond the locked decisions; the owner may override.

## Prerequisite

M1 and M2 are merged to `main`. This plan builds on: `intake/db.ts`, `intake/migrations.ts` (versions 1–3; the `admin_credential` table already exists from v1, unused), `intake/config.ts` (has `backupTarget`, `storageHighWaterBytes`, `sessionTtlMs`, `dataDir`, `attachmentDir`), `intake/crypto.ts` (`hashSecret`/`verifySecret`/`randomId`/`randomToken`), `intake/audit.ts`, `intake/attachmentStore.ts`, `intake/rateLimiter.ts`, `middleware/auth.ts` (the shared-token `createAuthMiddleware` shim to be replaced), and the Central admin routers (`routes/intake/{admin,changes,claim,triage,promotion}.ts`, each currently `router.use(createAuthMiddleware(adminToken))`).

---

## File Structure (Milestone 3)

Phase A (new/modified):
- `dashboard/server/src/intake/adminCredentialStore.ts` — provision/verify/list/revoke hashed admin credentials with capabilities.
- `dashboard/server/src/middleware/adminAuth.ts` — real admin guard: header-only bearer verified against a hashed credential, capability check, hard-fail when none configured.
- `dashboard/server/src/intake/retention.ts` — the retention sweep (pure, injected clock): compute + delete expired attachments/sessions per policy, audited.
- `dashboard/server/src/intake/storage.ts` — attachment-dir size accounting + high-water check.
- `dashboard/server/src/intake/backup.ts` — SQLite-consistent online backup + attachment manifest + rotation; restore verifier.
- `dashboard/server/src/routes/intake/adminOps.ts` — admin endpoints: throttled-session list, storage status, run-retention, run-backup, manage admin credentials.
- `dashboard/server/src/cli/intake-ops.ts` — CLI: `provision-admin`, `retention`, `backup`, `restore-verify`.
- Modified: `intake/attachmentStore.ts` (enforce high-water before write), `intake/rateLimiter.ts` (expose a `throttledKeys(now)` read), `routes/intake/{admin,changes,claim,triage,promotion}.ts` + `routes/local/index.ts` (swap the shim for `adminAuth`), `intake/config.ts` (+ retention/backup interval + `adminAuthDisabled` guardrails), `index.ts` (optional in-process retention/backup schedulers gated by config), `.env.example`, `.gitignore`.

Phase B (new, infra + docs):
- `dashboard/deploy/Caddyfile` (+ `nginx.conf.example`) — TLS reverse proxy for the Central service.
- `dashboard/deploy/README-tls.md` — internal hostname, cert trust, proxy setup, and the end-to-end verification runbook.
- `dashboard/deploy/verification-checklist.md` — the cross-machine security/abuse/failure-recovery acceptance checklist.

---

## Task 1 `[anywhere]`: Real admin credential + capability model (replace the shared-token shim)

**Files:**
- Create: `dashboard/server/src/intake/adminCredentialStore.ts` (+ `.test.ts`)
- Create: `dashboard/server/src/middleware/adminAuth.ts` (+ `.test.ts`)
- Modify: `dashboard/server/src/intake/config.ts` (add `adminAuthMode`)
- Modify: the five Central admin routers + `routes/local/index.ts` to use `makeAdminAuth(...)` instead of `createAuthMiddleware(adminToken)`

**Interfaces:**
- Consumes: `getDb`, `hashSecret`/`verifySecret`/`randomId`/`randomToken`, `recordAudit`; the existing `admin_credential(id,label,cred_hash,salt,capabilities,created_at)` table (from migration v1).
- Produces:
  - `provisionAdminCredential(db, { label, capabilities }): { id; secret }` — generates a random secret (`randomToken(24)`), stores only its scrypt hash + the capability list; returns the raw secret **once**.
  - `verifyAdminSecret(db, secret): { ok: true; id; capabilities: string[] } | { ok: false }` — constant-time verify by scanning non-null credentials (few rows; same pattern as `verifyAccessCode`).
  - `listAdminCredentials(db)` / `revokeAdminCredential(db, id)`.
  - `makeAdminAuth(db, { requiredCapability?, mode })` Express middleware: reads the bearer **from the `Authorization` header ONLY** (never `?token=` — closes the M1 finding); verifies against a hashed credential; enforces `requiredCapability` if given; on no credential **hard-fails 503** when `mode==='required'` (closes the M1 "admin open when unset" finding) — it never passes through open.
  - Capabilities (`[PLAN-ASSUMPTION]`): `intake:read` (changes feed), `intake:claim`, `intake:triage`, `intake:promote`, `intake:admin` (issue codes, ops). The Local machine's credential holds all of `intake:*`.

- [ ] **Step 1: Write the failing store test**

```typescript
// dashboard/server/src/intake/adminCredentialStore.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { provisionAdminCredential, verifyAdminSecret, revokeAdminCredential } from './adminCredentialStore';

test('provisioned secret verifies with its capabilities; raw secret is never stored', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const { id, secret } = provisionAdminCredential(db, { label: 'local-machine', capabilities: ['intake:read', 'intake:promote'] });
  const stored = db.prepare('SELECT cred_hash FROM admin_credential WHERE id = ?').get(id) as any;
  assert.notEqual(stored.cred_hash, secret);
  const v = verifyAdminSecret(db, secret);
  assert.deepEqual(v, { ok: true, id, capabilities: ['intake:read', 'intake:promote'] });
});

test('wrong and revoked secrets do not verify', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const { id, secret } = provisionAdminCredential(db, { label: 'x', capabilities: ['intake:admin'] });
  assert.deepEqual(verifyAdminSecret(db, 'nope'), { ok: false });
  revokeAdminCredential(db, id);
  assert.deepEqual(verifyAdminSecret(db, secret), { ok: false });
});
```

- [ ] **Step 2: Run test → fail**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/adminCredentialStore.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `adminCredentialStore.ts`**

```typescript
// dashboard/server/src/intake/adminCredentialStore.ts
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
```

Migration note: the v1 `admin_credential` table has no `revoked_at` column. Append **migration v4** to `migrations.ts` adding it idempotently via the existing `addColumnIfMissing(db, 'admin_credential', 'revoked_at', 'INTEGER')` helper (from M2 Task 1) — do not edit v1. Include this in Step 3's commit.

- [ ] **Step 4: Run store test → pass**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/adminCredentialStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing middleware test**

```typescript
// dashboard/server/src/middleware/adminAuth.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../intake/db';
import { runMigrations } from '../intake/migrations';
import { provisionAdminCredential } from '../intake/adminCredentialStore';
import { makeAdminAuth } from './adminAuth';

function res() {
  return { statusCode: 0, body: null as any,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; }, end() { return this; } };
}

test('hard-fails 503 when no credential is configured (mode required)', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const mw = makeAdminAuth(db, { mode: 'required' });
  const r = res(); let n = false;
  mw({ headers: {} } as any, r as any, () => { n = true; });
  assert.equal(r.statusCode, 503); assert.equal(n, false);
});

test('accepts a valid header bearer with the required capability; rejects query token and missing capability', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const { secret } = provisionAdminCredential(db, { label: 'm', capabilities: ['intake:promote'] });
  const mw = makeAdminAuth(db, { mode: 'required', requiredCapability: 'intake:promote' });

  // query token is NOT accepted
  const r1 = res(); let n1 = false;
  mw({ headers: {}, query: { token: secret } } as any, r1 as any, () => { n1 = true; });
  assert.equal(r1.statusCode, 401); assert.equal(n1, false);

  // valid header bearer with capability
  const r2 = res(); let n2 = false;
  mw({ headers: { authorization: `Bearer ${secret}` } } as any, r2 as any, () => { n2 = true; });
  assert.equal(n2, true);

  // valid credential but WRONG capability
  const mw2 = makeAdminAuth(db, { mode: 'required', requiredCapability: 'intake:admin' });
  const r3 = res(); let n3 = false;
  mw2({ headers: { authorization: `Bearer ${secret}` } } as any, r3 as any, () => { n3 = true; });
  assert.equal(r3.statusCode, 403); assert.equal(n3, false);
});
```

- [ ] **Step 6: Run → fail, implement `adminAuth.ts`, run → pass**

```typescript
// dashboard/server/src/middleware/adminAuth.ts
import type { Request, Response, NextFunction } from 'express';
import type { DB } from '../intake/db';
import { verifyAdminSecret } from '../intake/adminCredentialStore';

export function makeAdminAuth(
  db: DB, opts: { mode: 'required' | 'disabled'; requiredCapability?: string }
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (opts.mode === 'disabled') { next(); return; } // local dev ONLY; never in the LAN deployment

    // Header only — never a query-string token (avoids the secret landing in proxy logs/URLs).
    const header = req.headers.authorization;
    const secret = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    const anyConfigured = (db.prepare('SELECT COUNT(*) AS n FROM admin_credential WHERE revoked_at IS NULL').get() as any).n > 0;
    if (!anyConfigured) { res.status(503).json({ error: 'admin auth not provisioned' }); return; } // hard-fail, never open

    if (!secret) { res.status(401).json({ error: 'admin credential required' }); return; }
    const v = verifyAdminSecret(db, secret);
    if (!v.ok) { res.status(401).json({ error: 'invalid admin credential' }); return; }
    if (opts.requiredCapability && !v.capabilities.includes(opts.requiredCapability)) {
      res.status(403).json({ error: 'insufficient capability' }); return;
    }
    (req as any).admin = { id: v.id, capabilities: v.capabilities };
    next();
  };
}
```

Add `adminAuthMode: (env.INTAKE_ADMIN_AUTH_MODE || 'required').trim()` to `config.ts` (`'required' | 'disabled'`; default `required` — the LAN deployment must never run `disabled`). Document in `.env.example` with a loud comment.

- [ ] **Step 7: Swap the shim on every Central admin router + the Local client's expectation**

In each of `routes/intake/{admin,changes,claim,triage,promotion}.ts`, replace `router.use(createAuthMiddleware(adminToken))` with `router.use(makeAdminAuth(db, { mode: intakeConfig.adminAuthMode, requiredCapability: '<the route's capability>' }))` (changes→`intake:read`, claim→`intake:claim`, triage→`intake:triage`, promotion→`intake:promote`, admin→`intake:admin`). The routers already receive `db`; thread `intakeConfig`. The Local `centralClient` already sends `Authorization: Bearer <secret>` — no client change needed; the secret it sends is now a provisioned admin credential (configured via `INTAKE_CENTRAL_ADMIN_SECRET` on the Local machine `[PLAN-ASSUMPTION]`) rather than the plaintext dashboard token.

Backward-compat bridge (`[PLAN-ASSUMPTION]`, keep M1/M2 tests green): the existing tests pass a literal `adminToken: 'admin-secret'`. To avoid rewriting every M1/M2 route test, keep `createAuthMiddleware` usable in `mode: 'disabled'` dev/test and have the route builders accept an optional injected auth middleware, defaulting to `makeAdminAuth`. Confirm the full suite stays green after the swap; where a test asserted bearer-token behavior, provision an in-test admin credential instead.

- [ ] **Step 8: Full suite + build + commit**

Run: `cd dashboard/server && npm test && npm run build` → green.

```bash
git add dashboard/server/src/intake/adminCredentialStore.ts dashboard/server/src/intake/adminCredentialStore.test.ts dashboard/server/src/middleware/adminAuth.ts dashboard/server/src/middleware/adminAuth.test.ts dashboard/server/src/intake/migrations.ts dashboard/server/src/intake/config.ts dashboard/server/src/routes/intake/admin.ts dashboard/server/src/routes/intake/changes.ts dashboard/server/src/routes/intake/claim.ts dashboard/server/src/routes/intake/triage.ts dashboard/server/src/routes/intake/promotion.ts dashboard/server/src/routes/local/index.ts dashboard/server/.env.example
git commit -m "feat(intake): real hashed admin credential + capability guard (replace shared-token shim)"
```

---

## Task 2 `[anywhere]`: Retention/deletion sweep

**Files:** Create `dashboard/server/src/intake/retention.ts` (+ `.test.ts`).

**Interfaces:**
- Consumes: `getDb`, `intakeConfig` (TTLs), `recordAudit`, `intake/attachmentStore.ts` `deleteAttachment` (soft-delete + unlink), `fs`.
- Produces: `runRetention(db, { now, attachmentDir, policy }): { attachmentsDeleted; sessionsDeleted; auditKept }` (Decision #7):
  - Closed-intake attachments deleted **90 days** after closure — for intakes in state `closed`/`promoted` whose attachments' `created_at` (or the intake's closure time) is older than 90d, hard-delete the file + mark the row deleted, audited.
  - Inactive login sessions deleted **7 days** after `expires_at` (they already stop validating at expiry; this actually removes the rows).
  - Structured intake/triage/decision/access-code/audit rows retained **1 year** — the sweep must NOT delete these before a year; assert the boundary in tests.
  - Every deletion emits a server-derived audit event; the sweep never throws into the tester path (wrap per-item, collect errors, return a summary).
- `now` is injected so tests are deterministic.

- [ ] **Step 1: failing test** — seed an intake with an attachment `created_at` 100 days ago in a `closed` intake and an expired session 8 days past expiry; assert both are deleted, and a 1-year-old-minus-a-day structured row is retained. (Full code in the implementer's brief — mirror the M2 store-test style with an in-memory DB + temp attachment dir.)
- [ ] **Step 2–4:** implement `runRetention` (parameterized SQL, per-item try/catch, audit each deletion), run → pass.
- [ ] **Step 5:** commit `feat(intake): retention sweep (attachments 90d, sessions 7d, structured 1y)`.

---

## Task 3 `[anywhere]`: Storage high-water enforcement

**Files:** Create `dashboard/server/src/intake/storage.ts` (+ `.test.ts`); modify `intake/attachmentStore.ts`.

**Interfaces:**
- `dirSizeBytes(dir): number` (sum of non-deleted attachment `byte_size` from SQLite — authoritative and cheap — rather than walking the fs `[PLAN-ASSUMPTION]`), and `overHighWater(db, cfg): boolean`.
- In `attachmentStore.storeAttachment`, BEFORE writing bytes, if `overHighWater` → throw `STORAGE_FULL`; the attachments route maps it to **HTTP 507** (Insufficient Storage) `[PLAN-ASSUMPTION]`. This does not affect structured intake submission (Decision #7: submissions keep working; only new uploads are refused).

- [ ] **Step 1:** failing test — set a tiny `storageHighWaterBytes`, store attachments until over, assert the next `storeAttachment` throws `STORAGE_FULL` and the attachments route returns 507.
- [ ] **Step 2–4:** implement, wire the error→507 in `routes/intake/attachments.ts`, run → pass (existing attachment tests stay green).
- [ ] **Step 5:** commit `feat(intake): enforce attachment storage high-water mark (507)`.

---

## Task 4 `[anywhere]`: Throttled-session admin visibility

**Files:** Modify `intake/rateLimiter.ts` (add `throttledKeys(now): { key; attempts; retryAfterMs }[]`); create `routes/intake/adminOps.ts` with `GET /api/intake/admin/throttled` (capability `intake:admin`).

- [ ] Add a read-only `throttledKeys` accessor to `WindowLimiter` (iterate buckets currently over `maxAttempts`) — no behavior change to `hit`. Test it with the injected clock. Expose the two shared limiters (code-exchange + submission) to the admin endpoint via the module that constructs them. Commit `feat(intake): admin visibility into throttled sessions`.

---

## Task 5 `[anywhere]`: SQLite-consistent backup + tested restore

**Files:** Create `dashboard/server/src/intake/backup.ts` (+ `.test.ts`); create `dashboard/server/src/cli/intake-ops.ts`; modify `.env.example`, `.gitignore`.

**Interfaces (Decision #13):**
- `runBackup(db, { backupTarget, attachmentDir, now, keepDaily=7, keepWeekly=4 }): { snapshotPath; manifestPath }` — uses better-sqlite3's **online** `db.backup(path)` (WAL-consistent, NOT a live-file copy), writes an attachment manifest (name, size, sha256 from the `attachment` rows), rotates to 7 daily + 4 weekly sets, and stores backups **outside** the git repo and the live data dir (config-driven `backupTarget`, already in config). A backup failure returns an error the caller surfaces as an admin warning — it never blocks submissions.
- `verifyRestore(snapshotPath): { ok; tables: string[] }` — opens the snapshot read-only, runs `PRAGMA integrity_check`, confirms the core tables exist. This is the tested-restore requirement.
- Secrets: the snapshot contains the same hashed columns as the live DB (access-code hashes, admin-credential hashes) — never raw. Document that the backup target must have filesystem permissions no broader than the live data dir.

- [ ] **Step 1:** failing test — seed a DB + a temp attachment dir, `runBackup` to a temp target, assert the snapshot file exists, `PRAGMA integrity_check` is `ok`, the manifest lists the attachments with hashes, and `verifyRestore` returns `ok:true` with the core tables. Then seed 12 daily backups and assert rotation keeps 7.
- [ ] **Step 2–4:** implement `backup.ts` (use `db.backup()`), the `intake-ops.ts` CLI (`provision-admin`/`retention`/`backup`/`restore-verify` subcommands), run → pass.
- [ ] **Step 5:** add a `scripts` entry (`"intake:ops": "ts-node src/cli/intake-ops.ts"`), gitignore the default backup dir, `.env.example` the backup keys; optionally add a config-gated in-process scheduler in `index.ts` (`INTAKE_BACKUP_INTERVAL_MS`, `INTAKE_RETENTION_INTERVAL_MS`; default off) that calls `runBackup`/`runRetention` and logs failures as warnings. Commit `feat(intake): SQLite-consistent backup + manifest + rotation + restore verify`.

---

## Task 6 `[office-LAN]`: TLS reverse proxy + internal hostname + cert trust

> **Executable only on the office LAN / the Central host (`192.168.1.140`).** Author the config + runbook now; run and verify when back on-site. This closes the M1 Definition-of-Done deployment prerequisite (the `Secure` session cookie requires TLS in front of the service, or LAN testers silently 401 — see the M1 whole-branch review).

**Files:** Create `dashboard/deploy/Caddyfile`, `dashboard/deploy/nginx.conf.example`, `dashboard/deploy/README-tls.md`.

**Deliverable (Caddy `[PLAN-ASSUMPTION]` — auto-HTTPS with an internal CA is the least-effort path for a LAN hostname):**

```
# dashboard/deploy/Caddyfile — terminates TLS for the Central Intake service.
# Internal hostname (pick one and add it to LAN DNS or each tester's hosts file):
intake.games-labs.lan {
    tls internal            # Caddy's built-in internal CA; distribute the root to testers (see README-tls.md)
    encode zstd gzip
    # Central Express app listens on loopback only; Caddy is the sole public listener.
    reverse_proxy 127.0.0.1:4310 {
        header_up X-Forwarded-Proto https
    }
    request_body { max_size 6MB }   # slightly above the 5MB attachment cap
}
```

**Runbook (`README-tls.md`) must cover, with exact commands, and a verification section that is the task's acceptance test:**

- [ ] Bind the Central Express app to loopback (`127.0.0.1:4310`) so Caddy is the only LAN-facing listener; set `DASHBOARD_ALLOWED_ORIGINS=https://intake.games-labs.lan` and the intake cookie/CSRF origin allowlist to the HTTPS hostname.
- [ ] Choose the internal hostname; add it to LAN DNS (or document the per-tester `hosts` entry pointing at `192.168.1.140`).
- [ ] Install Caddy on the Central host; run with the Caddyfile; confirm it obtains an internal cert.
- [ ] Distribute Caddy's internal root CA to each tester machine's trust store (documented per-OS) so the cert is trusted (no browser warning).
- [ ] **Verify (acceptance):** from a second machine on the LAN, over `https://intake.games-labs.lan`: (a) the cert is trusted; (b) an access-code exchange sets the `Secure` cookie and a subsequent request is accepted (proving the Secure cookie now works — the exact failure mode the M1 review flagged); (c) plain `http://192.168.1.140:4310` is NOT reachable from off-box (loopback bind confirmed); (d) an attachment upload at the 5MB cap succeeds through the proxy and a 6MB+ body is rejected.
- [ ] Document the nginx equivalent in `nginx.conf.example` (TLS termination + `proxy_pass` to loopback + `client_max_body_size 6m`) for operators who prefer nginx.

Commit (config + docs only; no app-code test): `docs(intake): TLS reverse proxy + internal hostname runbook (M3)`.

---

## Task 7 `[office-LAN]`: End-to-end cross-machine security / abuse / failure-recovery verification

> **Executable only on the office LAN**, after Tasks 1–6 are deployed to the Central + Local machines. This is the final gate before opening the tester surface. Author the checklist now; execute on-site.

**Files:** Create `dashboard/deploy/verification-checklist.md` — a concrete, command-by-command acceptance checklist. Each item has an expected result; the task is "done" when all pass on the real two-machine setup.

Checklist content (author now, run on-LAN):
- [ ] **Auth boundary:** every Central admin endpoint (changes/claim/triage/promotion/admin ops) rejects a missing/invalid/insufficient-capability credential (401/403) and hard-fails 503 if no admin credential is provisioned; no `?token=` query is accepted; the tester surface remains reachable only via session cookie.
- [ ] **Enumeration:** a wrong access code and a wrong admin credential both return generic errors with no user/validity signal; repeated attempts hit the rate limiter (429 + `Retry-After`) and appear in the admin throttled-session view.
- [ ] **CSRF / no state-changing GET:** every mutating tester route requires the CSRF token + allowed Origin; confirm no GET mutates state; a cross-origin POST is rejected.
- [ ] **Redaction across the wire:** promote a real test intake end-to-end (Local→Central), then inspect the created `runs/<TASK-ID>/task.md` + `status.yaml` and confirm NO tester id/PII/secret/attachment content is present, only the redacted projection; confirm `validate-yaml.rb` passes on the promoted TASK.
- [ ] **Idempotency under real conditions:** double-promote the same intake (and simulate a dropped response by killing the Local request mid-flight) → exactly one TASK dir, the same TASK id, no orphan (exercises the M2 lost-response fix on real hardware).
- [ ] **Storage + retention:** fill attachments past the high-water mark → uploads 507 while structured submission still works; run the retention CLI against a seeded old-data snapshot → correct deletions, all audited.
- [ ] **Backup/restore drill:** run `intake:ops backup` on the Central host; verify the snapshot with `restore-verify`; do a full restore into a scratch data dir and boot the service against it read-only; confirm intakes/audit are intact and no raw secrets are present.
- [ ] **Failure recovery:** stop the Central service, hit Local `/refresh` and `/promote` → Local returns 502 (not a crash); restart Central → Local resumes from its durable cursor with no missed/duplicated changes.

Commit (docs only): `docs(intake): cross-machine security/abuse/failure-recovery verification checklist (M3)`.

---

## Milestone 3 Definition of Done

**Phase A (shippable off-LAN):**
- The shared plaintext admin token is gone; every Central admin route requires a hashed admin credential presented in the `Authorization` header with the right capability, hard-fails when unprovisioned, and never accepts a query-string token.
- Retention sweep deletes closed-intake attachments (90d) and inactive sessions (7d), retains structured/audit data (1y), audits every deletion, and never blocks the tester path.
- Attachment uploads are refused (507) past the storage high-water mark while intake submission keeps working.
- Admins can see throttled sessions.
- A SQLite-consistent backup (online `db.backup()`) + attachment manifest + 7-daily/4-weekly rotation exists, with a verified restore path, run via CLI (and optionally a config-gated scheduler); backups hold only hashed secrets; failures warn without blocking.
- `npm test` + `npm run build` green.

**Phase B (requires office LAN):**
- The Central service sits behind a TLS-terminating reverse proxy on an internal hostname with a trusted internal cert; the `Secure` cookie works end-to-end for LAN testers; the app binds loopback-only.
- The full cross-machine security/abuse/failure-recovery checklist passes on the real two-machine setup.

## Self-Review

**Decision coverage (M3 subset):** #2 admin separate credential + capability set → Task 1 (+ closes M1 hardening: header-only, hard-fail-when-unset); #3 TLS transport + no state-changing GET → Task 6 + Task 7 checklist; #7 retention (90d/7d/1y) + storage high-water + throttled visibility → Tasks 2, 3, 4; #13 SQLite-consistent backup + rotation + tested restore + non-blocking failure → Task 5; #1/#5/#6/#12/#14 cross-machine integrity → Task 7 end-to-end verification.

**Off-LAN split is explicit:** Tasks 1–5 (`[anywhere]`) are pure app code with temp-dir/in-memory tests and ship real security value now; Tasks 6–7 (`[office-LAN]`) are authored now but gated on the operator being back on the office LAN. No Phase A task depends on the proxy existing.

**Placeholder scan:** Phase A tasks carry real interfaces and the security-critical code (admin-credential store, adminAuth middleware) is written in full; Tasks 2–5's per-step code is left to each task's brief at the same M1/M2 granularity (interfaces + test intent + exact policy values are specified). Phase B is intentionally procedure-style (config + runbook + acceptance checklist), not TDD units — correctly, since TLS/cross-machine behavior isn't unit-testable and must be verified on real hosts.

**Type/consistency:** `makeAdminAuth`/`verifyAdminSecret` capabilities are a single `intake:*` set reused across Tasks 1/4/6/7; `runRetention`/`runBackup`/`overHighWater` all take an injected `now` + config, matching the M1/M2 deterministic-test idiom; the backup uses the `backupTarget`/`storageHighWaterBytes`/`sessionTtlMs` config that already exists from M1.

# Intake Board — Tester Submission UI (M4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the tester-facing submission page — a Central-served UI where a tester logs in with an access code, submits a structured intake (with attachments), and sees "My Intakes" with a friendly status — plus the backend contract extensions it needs, with nothing internal ever reaching the tester's browser.

**Architecture:** Backend-first. Extend the existing `ai-dev-office/dashboard` Express/TypeScript backend (migration v5 for structured fields, a single Central-owned `toTesterIntake` projection used by every tester response, a products endpoint, an admin detail endpoint for Local, promotion projection → promo.v2, logout CSRF, static serving). Then a **separate Vite entry page** (`intake.html` → `src/intake/`) in the existing React client that renders the tester flow only, authenticating with the session cookie + CSRF token (never the admin bearer).

**Tech Stack:** Node + Express 4 + TypeScript, `better-sqlite3`, React + Vite (existing client), Node built-in `crypto`. Tests: Node's built-in test runner (`node --require ts-node/register --test`); frontend uses pure-logic `node:test` + in-app browser verification (no jest/vitest added).

## Global Constraints

- **Repo scope:** all changes under `ai-dev-office/dashboard/`. Meta/tooling repo — **no `TASK-` run**, no `status.yaml` of a run touched, no `knowledge-base/` edits.
- **Single tester projection:** every tester-facing response (`POST /api/intake/intakes`, `GET /api/intake/intakes`, `GET /api/intake/intakes/:id`) MUST return `toTesterIntake(row)` — never a raw DB row. The projection omits `tester_id`, raw `state`, `revision`, `change_seq`, `idempotency_key`, and all triage/promotion data.
- **Status mapping is server-side only** and fail-closed (unknown state → `"In review"`). The client has NO status-mapping table; it renders the server's `displayStatus`.
- **Tester auth is session cookie + CSRF**, never the admin bearer. The intake page uses `credentials:'include'` and an `X-CSRF-Token` header (value from the session-exchange response, in memory only). Never store the access code or CSRF token in localStorage or the URL.
- **Admin detail endpoint is separate** (`GET /api/intake/admin/intakes/:id`, capability `intake:read`) and returns the FULL row — it is NOT the tester projection and MUST NOT be reachable with a tester session.
- **Migrations:** append migration v5 only; never edit versions 1–4; add columns via the `addColumnIfMissing` PRAGMA-guarded helper so a re-run cannot throw.
- **Backward-compat:** all new intake fields are optional at the store layer; existing M1–M3 callers/tests must stay green. `npm test` and `npm run build` green after every task.
- **Node test runner only.** No jest/vitest/testing-library added to the client.
- **Path-scoped commits** — never `git add .`; unrelated untracked `runs/TASK-EAR-*` dirs exist.
- **`[PLAN-ASSUMPTION]`** marks choices beyond the locked spec; the owner may override.

## Prerequisite / current signatures (verified)

- `intake/intakeStore.ts`: `interface IntakeRow { id; tester_id; title; body; product_hint: string|null; state: string; revision: number; idempotency_key; created_at; updated_at; change_seq }`; `submitIntake(db, { testerId, title, body, productHint?, idempotencyKey? }): { intake: IntakeRow; deduped: boolean }`; `getIntake(db, id): IntakeRow | null` (`SELECT *`); `listIntakes(db, {testerId?}): IntakeSummary[]`; `setIntakeState(...)`; `INTAKE_STATES = ['submitted','triaged','needs_scope_review','ai_failed','decided','promoted','closed']`.
- `routes/intake/intakes.ts`: `buildIntakesRouter(db, { limiter? })` — POST returns the raw `intake` row (201/200), GET `/` returns `listIntakes(...)`, GET `/:id` returns the raw row after a `tester_id` ownership check.
- `routes/intake/index.ts`: tester routes mounted `app.use('/api/intake/intakes', requireSession, csrf, json(), buildIntakesRouter(...))`; session `app.use('/api/intake/session', json(), buildAuthRouter(db, {limiter}))`; admin routers use `makeAdminAuth(db, {mode, requiredCapability})`.
- `routes/intake/auth.ts`: `buildAuthRouter(db, {limiter})` — POST `/` (code exchange, sets cookie, returns `{csrfToken, expiresAt}`), DELETE `/` (`requireTesterSession`, no CSRF today).
- `middleware/csrf.ts`: `makeCsrfGuard({ allowedOrigins })`. `middleware/adminAuth.ts`: `makeAdminAuth(db, { mode, requiredCapability })`. `intake/config.ts`: has `parseRepoAllowlist`, `adminAuthMode`, `allowedOrigins`.
- `local/centralClient.ts`: `makeCentralClient({ baseUrl, adminToken, fetchImpl? })` returns `{ getChanges, claim, ..., recordPromotion }`. `local/promotionProjection.ts`: `PROMOTION_PROJECTION_VERSION='promo.v1'`, `PromotedProjection`, `projectIntakeForPromotion`, `assertNoForbiddenFields`, `renderTaskMd` (in `promotion.ts`).

---

## File Structure

Backend (Central):
- `intake/migrations.ts` — MODIFY: append migration v5 (5 nullable columns).
- `intake/intakeStore.ts` — MODIFY: `submitIntake` accepts/validates/stores the 5 fields; `listIntakes` returns full rows.
- `intake/testerProjection.ts` — CREATE: `toTesterIntake(row)` + `displayStatusFor(state)` (the ONLY status mapping).
- `routes/intake/intakes.ts` — MODIFY: project every response.
- `routes/intake/auth.ts` — MODIFY: CSRF-guard the DELETE (logout).
- `intake/config.ts` — MODIFY: `parseProductList` + `intakeProductList`.
- `routes/intake/products.ts` — CREATE: `GET /api/intake/products`.
- `routes/intake/adminIntakes.ts` — CREATE: `GET /api/intake/admin/intakes/:id` (cap `intake:read`).
- `local/centralClient.ts` — MODIFY: add `getIntakeDetail(id)`.
- `local/promotionProjection.ts` + `local/promotion.ts` — MODIFY: promo.v2 + the 5 fields in `renderTaskMd`.
- `routes/intake/index.ts` — MODIFY: mount products + adminIntakes; thread the CSRF guard into the session router for logout.
- `server/src/index.ts` — MODIFY: static-serve the built `/intake` page.

Frontend (Central-served):
- `client/intake.html` — CREATE: second Vite entry.
- `client/vite.config.ts` — MODIFY: `rollupOptions.input` multi-page.
- `client/src/intake/main.tsx` — CREATE: entry.
- `client/src/intake/intakeApi.ts` (+ `.test.ts`) — CREATE: cookie+CSRF fetch client + pure-logic helpers.
- `client/src/intake/IntakeApp.tsx` — CREATE: code entry → form → My Intakes.
- `client/src/intake/components/*` — CREATE: `CodeEntry`, `IntakeForm`, `MyIntakes` (split by responsibility).

---

## Task 1: Migration v5 + structured intake fields

**Files:**
- Modify: `dashboard/server/src/intake/migrations.ts`
- Modify: `dashboard/server/src/intake/intakeStore.ts`
- Modify: `dashboard/server/src/intake/intakeStore.test.ts`

**Interfaces:**
- Consumes: `addColumnIfMissing` (existing), `IntakeRow`.
- Produces: migration v5 adds `severity, repro_steps, expected, actual, environment` (all TEXT, nullable). `submitIntake` gains optional `severity?, reproSteps?, expected?, actual?, environment?`; validates `severity ∈ {blocker,high,medium,low}` when present, caps repro/expected/actual ≤ 8000 and environment ≤ 1000; stores them. `IntakeRow` gains the five fields (`severity: string|null; repro_steps: string|null; expected: string|null; actual: string|null; environment: string|null`).

- [ ] **Step 1: Write the failing test**

```typescript
// add to dashboard/server/src/intake/intakeStore.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { submitIntake, getIntake } from './intakeStore';

function seedTester(db: any, id = 't1') {
  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)').run(id, 'T', 1);
}

test('submitIntake stores structured fields and severity enum is validated', () => {
  const db = openDb(':memory:'); runMigrations(db); seedTester(db);
  const { intake } = submitIntake(db, {
    testerId: 't1', title: 'Crash', body: 'desc',
    severity: 'high', reproSteps: '1. open 2. click', expected: 'ok', actual: 'boom', environment: 'iOS 18',
  });
  const row = getIntake(db, intake.id)!;
  assert.equal(row.severity, 'high');
  assert.equal(row.repro_steps, '1. open 2. click');
  assert.equal(row.expected, 'ok');
  assert.equal(row.actual, 'boom');
  assert.equal(row.environment, 'iOS 18');
  assert.throws(() => submitIntake(db, { testerId: 't1', title: 'x', body: 'y', severity: 'urgent' as any }));
});

test('structured fields are optional (backward-compat)', () => {
  const db = openDb(':memory:'); runMigrations(db); seedTester(db);
  const { intake } = submitIntake(db, { testerId: 't1', title: 'x', body: 'y' });
  const row = getIntake(db, intake.id)!;
  assert.equal(row.severity, null);
  assert.equal(row.repro_steps, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/intakeStore.test.ts`
Expected: FAIL — columns/params missing.

- [ ] **Step 3: Append migration v5**

In `intake/migrations.ts`, add to the `MIGRATIONS` array (do NOT touch v1–v4). Follow the v2/v4 pattern: keep the versioned `sql` a no-op and add the columns via the guarded helper. Add a `version: 5` entry with `sql: 'SELECT 1;'`, and in `runMigrations`'s per-version apply path add, guarded by `m.version === 5`:

```typescript
addColumnIfMissing(db, 'intake', 'severity', 'TEXT');
addColumnIfMissing(db, 'intake', 'repro_steps', 'TEXT');
addColumnIfMissing(db, 'intake', 'expected', 'TEXT');
addColumnIfMissing(db, 'intake', 'actual', 'TEXT');
addColumnIfMissing(db, 'intake', 'environment', 'TEXT');
```

(Mirror exactly how `version === 4` / `version === 2` invoke `addColumnIfMissing` in the current file.)

- [ ] **Step 4: Extend `submitIntake` + `IntakeRow`**

In `intakeStore.ts`:
- Add to `IntakeRow`: `severity: string | null; repro_steps: string | null; expected: string | null; actual: string | null; environment: string | null;`
- Add module consts: `const SEVERITIES = ['blocker','high','medium','low']; const MAX_LONG = 8000; const MAX_ENV = 1000;`
- Extend `submitIntake`'s input type with `severity?: string; reproSteps?: string; expected?: string; actual?: string; environment?: string;`
- After the existing title/body validation, add:

```typescript
const severity = input.severity?.trim() || null;
if (severity && !SEVERITIES.includes(severity)) throw new Error(`severity must be one of ${SEVERITIES.join(', ')}`);
const clip = (v: string | undefined, max: number, label: string) => {
  const s = (v ?? '').trim();
  if (s.length > max) throw new Error(`${label} must be <= ${max} chars`);
  return s || null;
};
const reproSteps = clip(input.reproSteps, MAX_LONG, 'reproSteps');
const expected = clip(input.expected, MAX_LONG, 'expected');
const actual = clip(input.actual, MAX_LONG, 'actual');
const environment = clip(input.environment, MAX_ENV, 'environment');
```

- Update the INSERT to include the five columns (extend the column list + placeholders + `.run(...)` args in `insertAndStamp`). The dedupe early-return path is unchanged (a deduped submit stores nothing new).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/intakeStore.test.ts`
Expected: PASS. Then `cd dashboard/server && npm test` (full suite green — M1–M3 unaffected since fields are optional) and `npm run build`.

- [ ] **Step 6: Commit**

```bash
git add dashboard/server/src/intake/migrations.ts dashboard/server/src/intake/intakeStore.ts dashboard/server/src/intake/intakeStore.test.ts
git commit -m "feat(intake): migration v5 + structured intake fields (severity/repro/expected/actual/environment)"
```

---

## Task 2: The `toTesterIntake` projection + server-side status mapping

**Files:**
- Create: `dashboard/server/src/intake/testerProjection.ts` (+ `.test.ts`)

**Interfaces:**
- Consumes: `IntakeRow` (Task 1).
- Produces:
  - `displayStatusFor(state: string): string` — fail-closed mapping (unknown/unmapped → `'In review'`).
  - `TesterIntake` type + `toTesterIntake(row: IntakeRow): TesterIntake` returning ONLY `{ id, title, productHint, body, severity, reproSteps, expected, actual, environment, createdAt, displayStatus }` — never `tester_id`, `state`, `revision`, `change_seq`, `idempotency_key`, or triage/promotion data.

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/server/src/intake/testerProjection.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toTesterIntake, displayStatusFor } from './testerProjection';

const row: any = {
  id: 'INTAKE-1', tester_id: 'TSTR-secret', title: 'Bug', body: 'desc', product_hint: 'wallet',
  state: 'ai_failed', revision: 3, change_seq: 9, idempotency_key: 'k',
  severity: 'high', repro_steps: 'r', expected: 'e', actual: 'a', environment: 'env',
  created_at: 1700, updated_at: 1800,
};

test('projection exposes only allowed keys and maps status server-side', () => {
  const p = toTesterIntake(row);
  assert.deepEqual(Object.keys(p).sort(), ['actual','body','createdAt','displayStatus','environment','expected','id','productHint','reproSteps','severity','title'].sort());
  assert.equal((p as any).tester_id, undefined);
  assert.equal((p as any).state, undefined);
  assert.equal((p as any).revision, undefined);
  assert.equal((p as any).idempotency_key, undefined);
  assert.equal(p.displayStatus, 'In review'); // ai_failed is hidden as "In review"
});

test('displayStatusFor is exhaustive and fail-closed', () => {
  assert.equal(displayStatusFor('submitted'), 'Submitted');
  assert.equal(displayStatusFor('triaged'), 'In review');
  assert.equal(displayStatusFor('decided'), 'In review');
  assert.equal(displayStatusFor('needs_scope_review'), 'In review');
  assert.equal(displayStatusFor('ai_failed'), 'In review');
  assert.equal(displayStatusFor('promoted'), 'Accepted — being worked on');
  assert.equal(displayStatusFor('closed'), 'Closed');
  assert.equal(displayStatusFor('some_future_state'), 'In review'); // fail-closed
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/testerProjection.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `testerProjection.ts`**

```typescript
// dashboard/server/src/intake/testerProjection.ts
import type { IntakeRow } from './intakeStore';

const STATUS_LABELS: Record<string, string> = {
  submitted: 'Submitted',
  triaged: 'In review',
  decided: 'In review',
  needs_scope_review: 'In review',
  ai_failed: 'In review',
  promoted: 'Accepted — being worked on',
  closed: 'Closed',
};

export function displayStatusFor(state: string): string {
  return STATUS_LABELS[state] ?? 'In review'; // fail-closed: never leak a raw/unknown state
}

export interface TesterIntake {
  id: string;
  title: string;
  productHint: string | null;
  body: string;
  severity: string | null;
  reproSteps: string | null;
  expected: string | null;
  actual: string | null;
  environment: string | null;
  createdAt: number;
  displayStatus: string;
}

export function toTesterIntake(row: IntakeRow): TesterIntake {
  // Explicit allowlist — never spread `row` (would leak state/tester_id/etc).
  return {
    id: row.id,
    title: row.title,
    productHint: row.product_hint,
    body: row.body,
    severity: row.severity,
    reproSteps: row.repro_steps,
    expected: row.expected,
    actual: row.actual,
    environment: row.environment,
    createdAt: row.created_at,
    displayStatus: displayStatusFor(row.state),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/testerProjection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/server/src/intake/testerProjection.ts dashboard/server/src/intake/testerProjection.test.ts
git commit -m "feat(intake): Central-owned tester projection + fail-closed status mapping"
```

---

## Task 3: Project every tester response (closes the POST leak)

**Files:**
- Modify: `dashboard/server/src/intake/intakeStore.ts` (`listIntakes` returns full rows)
- Modify: `dashboard/server/src/routes/intake/intakes.ts`
- Modify: `dashboard/server/src/routes/intake/intake.integration.test.ts`

**Interfaces:**
- Consumes: `toTesterIntake` (Task 2), `submitIntake`/`getIntake` (Task 1), `listIntakes`.
- Produces: `listIntakesFull(db, testerId): IntakeRow[]` (full rows, for projection). All three tester routes return `toTesterIntake(...)` — never a raw row.

- [ ] **Step 1: Write the failing integration test**

```typescript
// add to dashboard/server/src/routes/intake/intake.integration.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
// (reuse the file's existing app/session helpers; if it exposes a submit+cookie helper, use it)

test('no tester response leaks internal fields (POST, list, detail)', async () => {
  // Arrange: exchange a code -> session cookie + csrf (use the existing helper in this file).
  // Act: POST an intake, GET /api/intake/intakes, GET /api/intake/intakes/:id.
  // Assert on EACH response body:
  const forbidden = ['tester_id', 'state', 'revision', 'change_seq', 'idempotency_key'];
  for (const body of [postBody, listBody[0], detailBody]) {
    for (const k of forbidden) assert.equal(k in body, false, `${k} leaked`);
    assert.equal(typeof body.displayStatus, 'string');
    // raw internal state strings must not appear anywhere in the serialized body
    for (const raw of ['submitted','triaged','needs_scope_review','ai_failed','decided','promoted','closed']) {
      assert.equal(JSON.stringify(body).includes(`"state":"${raw}"`), false);
    }
  }
});
```

(Implementer: wire the arrange/act using the file's existing in-process-http + code-exchange helper — the same pattern already used for the happy-path submit test in this file — and capture `postBody`, `listBody`, `detailBody`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/server && node --require ts-node/register --test src/routes/intake/intake.integration.test.ts`
Expected: FAIL — POST/detail return the raw row containing `tester_id`/`state`.

- [ ] **Step 3: Add `listIntakesFull` + project the routes**

In `intakeStore.ts` add:

```typescript
export function listIntakesFull(db: DB, testerId: string): IntakeRow[] {
  return db.prepare('SELECT * FROM intake WHERE tester_id = ? ORDER BY created_at DESC').all(testerId) as IntakeRow[];
}
```

In `routes/intake/intakes.ts`, import `toTesterIntake` and `listIntakesFull`, and change the three handlers:

```typescript
// POST success:
res.status(deduped ? 200 : 201).json(toTesterIntake(intake));
// GET '/':
res.json(listIntakesFull(db, req.tester!.id).map(toTesterIntake));
// GET '/:id': after the ownership check
res.json(toTesterIntake(row));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd dashboard/server && node --require ts-node/register --test src/routes/intake/intake.integration.test.ts`
Expected: PASS. Then `cd dashboard/server && npm test` — full suite green (note: any existing test asserting the raw POST/GET shape must be updated to the projection; update those assertions, do not weaken them).

- [ ] **Step 5: Commit**

```bash
git add dashboard/server/src/intake/intakeStore.ts dashboard/server/src/routes/intake/intakes.ts dashboard/server/src/routes/intake/intake.integration.test.ts
git commit -m "feat(intake): return toTesterIntake on all tester routes (close POST leak)"
```

---

## Task 4: CSRF-guard logout

**Files:**
- Modify: `dashboard/server/src/routes/intake/auth.ts`
- Modify: `dashboard/server/src/routes/intake/index.ts`
- Modify: `dashboard/server/src/routes/intake/intake.integration.test.ts`

**Interfaces:**
- Consumes: `makeCsrfGuard` (existing). The session router's DELETE gets the CSRF guard; POST (code exchange, pre-token) stays exempt.

- [ ] **Step 1: Write the failing test**

```typescript
// add to intake.integration.test.ts
test('logout requires CSRF; code exchange does not', async () => {
  // exchange a code -> cookie + csrf
  // DELETE /api/intake/session WITHOUT X-CSRF-Token -> 403
  assert.equal(logoutNoCsrf.status, 403);
  // DELETE with the valid X-CSRF-Token + Origin -> 204
  assert.equal(logoutWithCsrf.status, 204);
});
```

- [ ] **Step 2: Run test → fail**

Run: `cd dashboard/server && node --require ts-node/register --test src/routes/intake/intake.integration.test.ts`
Expected: FAIL — logout currently succeeds without CSRF.

- [ ] **Step 3: Apply CSRF to the DELETE only**

`buildAuthRouter` builds one router with POST `/` and DELETE `/`. Give it access to the CSRF guard and apply it to DELETE only. Change the signature to `buildAuthRouter(db, opts: { limiter?; csrf?: RequestHandler } = {})` and, on the DELETE route, insert the guard: `router.delete('/', requireTesterSession, opts.csrf ?? ((_, __, next) => next()), (req, res) => { ... })`. In `routes/intake/index.ts`, pass the existing `csrf` guard: `buildAuthRouter(db, { limiter: codeExchangeLimiter, csrf })`. (POST `/` is untouched — code exchange has no session/token yet, the deliberate exception.)

- [ ] **Step 4: Run tests → pass; commit**

Run: `cd dashboard/server && npm test && npm run build` → green.

```bash
git add dashboard/server/src/routes/intake/auth.ts dashboard/server/src/routes/intake/index.ts dashboard/server/src/routes/intake/intake.integration.test.ts
git commit -m "feat(intake): CSRF-guard tester logout (session create stays exempt)"
```

---

## Task 5: Products config + endpoint

**Files:**
- Modify: `dashboard/server/src/intake/config.ts` (+ `config.test.ts`)
- Create: `dashboard/server/src/routes/intake/products.ts`
- Modify: `dashboard/server/src/routes/intake/index.ts`
- Modify: `dashboard/server/.env.example`

**Interfaces:**
- Produces: `parseProductList(raw): { value: string; label: string }[]` (validated; malformed/non-array/malshaped → `[]`, mirroring `parseRepoAllowlist`); `intakeConfig.intakeProductList`. `GET /api/intake/products` (behind the tester session) returns `{ products }`.

- [ ] **Step 1: Write failing config + route tests**

```typescript
// add to dashboard/server/src/intake/config.test.ts
import { parseProductList } from './config';
test('parseProductList validates and fails closed', () => {
  assert.deepEqual(parseProductList(undefined), []);
  assert.deepEqual(parseProductList('not json'), []);
  assert.deepEqual(parseProductList('{"value":"x"}'), []); // not an array
  assert.deepEqual(parseProductList('[{"value":"wallet"}]'), []); // missing label
  assert.deepEqual(parseProductList('[{"value":"wallet","label":"Wallet"},{"bad":1}]'), [{ value: 'wallet', label: 'Wallet' }]);
});
```

```typescript
// dashboard/server/src/routes/intake/products.test.ts (integration, in-process http)
test('GET /api/intake/products requires a tester session and returns the list', async () => {
  // no session cookie -> 401; with a valid session -> 200 { products: [...] }
});
```

- [ ] **Step 2: Run → fail**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/config.test.ts src/routes/intake/products.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `parseProductList` + config + route**

In `config.ts` (mirror `parseRepoAllowlist`):

```typescript
export interface ProductOption { value: string; label: string; }
export function parseProductList(raw: string | undefined): ProductOption[] {
  const t = (raw ?? '').trim();
  if (!t) return [];
  try {
    const parsed = JSON.parse(t);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is ProductOption => p && typeof p === 'object' && typeof p.value === 'string' && typeof p.label === 'string');
  } catch { return []; }
}
```
Add to `IntakeConfig`/`loadIntakeConfig`: `intakeProductList: parseProductList(env.INTAKE_PRODUCT_LIST)`.

```typescript
// routes/intake/products.ts
import { Router } from 'express';
import { intakeConfig } from '../../intake/config';
export function buildProductsRouter(): Router {
  const router = Router();
  router.get('/', (_req, res) => res.json({ products: intakeConfig.intakeProductList }));
  return router;
}
```
Mount behind the tester session in `index.ts` (before the bearer guard, session-guarded): `app.use('/api/intake/products', requireSession, buildProductsRouter());`. Document `INTAKE_PRODUCT_LIST` in `.env.example` with an example `[{"value":"Games-Labs-Wallet","label":"Wallet"}]` and note "Other" sends an empty product_hint.

- [ ] **Step 4: Run tests → pass; commit**

Run: `cd dashboard/server && npm test && npm run build` → green.

```bash
git add dashboard/server/src/intake/config.ts dashboard/server/src/intake/config.test.ts dashboard/server/src/routes/intake/products.ts dashboard/server/src/routes/intake/products.test.ts dashboard/server/src/routes/intake/index.ts dashboard/server/.env.example
git commit -m "feat(intake): configured product list + GET /api/intake/products"
```

---

## Task 6: Admin detail endpoint + centralClient.getIntakeDetail

**Files:**
- Create: `dashboard/server/src/routes/intake/adminIntakes.ts` (+ `.test.ts`)
- Modify: `dashboard/server/src/routes/intake/index.ts`
- Modify: `dashboard/server/src/local/centralClient.ts` (+ `centralClient.test.ts`)

**Interfaces:**
- Produces: `GET /api/intake/admin/intakes/:id` guarded by `makeAdminAuth(db, { mode: intakeConfig.adminAuthMode, requiredCapability: 'intake:read' })`, returning the FULL `IntakeRow` (admin sees everything) or 404. `centralClient.getIntakeDetail(id)` → GETs that path with the admin bearer.

- [ ] **Step 1: Write failing tests**

```typescript
// adminIntakes.test.ts — provision an admin credential (intake:read), assert:
//  - no bearer -> 401/403; with intake:read -> 200 full row (has tester_id/state)
//  - a tester SESSION cannot reach it (it's bearer/capability guarded, not session)
// centralClient.test.ts — getIntakeDetail sends GET /api/intake/admin/intakes/<id> with Authorization: Bearer
```

- [ ] **Step 2: Run → fail**

Run: `cd dashboard/server && node --require ts-node/register --test src/routes/intake/adminIntakes.test.ts src/local/centralClient.test.ts`
Expected: FAIL — missing route/method.

- [ ] **Step 3: Implement**

```typescript
// routes/intake/adminIntakes.ts
import { Router } from 'express';
import type { DB } from '../../intake/db';
import { getIntake } from '../../intake/intakeStore';
import { makeAdminAuth } from '../../middleware/adminAuth';
import { intakeConfig } from '../../intake/config';

export function buildAdminIntakesRouter(db: DB): Router {
  const router = Router({ mergeParams: true });
  router.use(makeAdminAuth(db, { mode: intakeConfig.adminAuthMode, requiredCapability: 'intake:read' }));
  router.get('/:id', (req, res) => {
    const row = getIntake(db, (req.params as any).id as string);
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(row); // FULL row — admin capability, not the tester projection
  });
  return router;
}
```
Mount in `index.ts` BEFORE `app.use('/api/intake/admin', ...buildAdminRouter)` so `/admin/intakes/:id` isn't shadowed: `app.use('/api/intake/admin/intakes', buildAdminIntakesRouter(db));`.

In `centralClient.ts` add to the returned object: `getIntakeDetail: (id: string) => req('GET', \`/api/intake/admin/intakes/${encodeURIComponent(id)}\`)`.

- [ ] **Step 4: Run tests → pass; commit**

Run: `cd dashboard/server && npm test && npm run build` → green.

```bash
git add dashboard/server/src/routes/intake/adminIntakes.ts dashboard/server/src/routes/intake/adminIntakes.test.ts dashboard/server/src/routes/intake/index.ts dashboard/server/src/local/centralClient.ts dashboard/server/src/local/centralClient.test.ts
git commit -m "feat(intake): admin intake-detail endpoint (cap intake:read) + centralClient.getIntakeDetail"
```

---

## Task 7: Promotion projection → promo.v2 (structured fields)

**Files:**
- Modify: `dashboard/server/src/local/promotionProjection.ts` (+ `.test.ts`)
- Modify: `dashboard/server/src/local/promotion.ts` (`renderTaskMd`)
- Modify: `dashboard/server/src/local/promotion.test.ts`

**Interfaces:**
- Produces: `PROMOTION_PROJECTION_VERSION = 'promo.v2'`; `PromotedProjection` gains `severity?, reproSteps?, expected?, actual?, environment?`; `projectIntakeForPromotion` fills them from the intake; `renderTaskMd` renders them; `assertNoForbiddenFields` unchanged and still passing.

- [ ] **Step 1: Write the failing test**

```typescript
// promotionProjection.test.ts additions
test('promo.v2 carries the structured fields and no identity leaks', () => {
  const intake: any = { id: 'INTAKE-1', title: 'B', body: 'd', product_hint: 'wallet', tester_id: 'TSTR-x',
    severity: 'high', repro_steps: 'r', expected: 'e', actual: 'a', environment: 'env' };
  const p = projectIntakeForPromotion({ intake, triage: { summary: 's' } as any });
  assert.equal(p.projectionVersion, 'promo.v2');
  assert.equal(p.severity, 'high');
  assert.equal(p.reproSteps, 'r');
  assert.equal((p as any).tester_id, undefined);
  assertNoForbiddenFields(p);
});
```

- [ ] **Step 2: Run → fail**

Run: `cd dashboard/server && node --require ts-node/register --test src/local/promotionProjection.test.ts`
Expected: FAIL (version is promo.v1, fields absent).

- [ ] **Step 3: Implement promo.v2**

In `promotionProjection.ts`: bump `PROMOTION_PROJECTION_VERSION = 'promo.v2'`; add the five optional fields to `PromotedProjection`; in `projectIntakeForPromotion` set `severity: input.intake.severity ?? undefined, reproSteps: input.intake.repro_steps ?? undefined, expected: ..., actual: ..., environment: ...` (extend the input intake type accordingly). Do NOT change `FORBIDDEN_KEYS` or `assertNoForbiddenFields`. In `promotion.ts` `renderTaskMd`, add a section rendering severity + Steps/Expected/Actual/Environment when present.

- [ ] **Step 4: Run tests → pass; commit**

Run: `cd dashboard/server && npm test && npm run build` → green (update any promo.v1 assertion in `promotion.test.ts` to v2).

```bash
git add dashboard/server/src/local/promotionProjection.ts dashboard/server/src/local/promotionProjection.test.ts dashboard/server/src/local/promotion.ts dashboard/server/src/local/promotion.test.ts
git commit -m "feat(intake): promotion projection promo.v2 with structured fields"
```

---

## Task 8: Frontend scaffold — Vite entry, intakeApi, static serving

**Files:**
- Create: `dashboard/client/intake.html`
- Modify: `dashboard/client/vite.config.ts`
- Create: `dashboard/client/src/intake/main.tsx`
- Create: `dashboard/client/src/intake/intakeApi.ts` (+ `intakeApi.test.ts`)
- Modify: `dashboard/server/src/index.ts` (static-serve the built page)
- Modify: `dashboard/server/.env.example` (`DASHBOARD_ALLOWED_ORIGINS` note)

**Interfaces:**
- Produces: `newIdempotencyKey(): string`; `makeIntakeApi(opts?: { fetchImpl?; getCsrf?; setCsrf? })` → `{ exchangeCode(code), submitIntake(body), listIntakes(), getProducts(), uploadAttachment(id, file), logout() }` — all use `credentials:'include'`; unsafe methods send `X-CSRF-Token`; `exchangeCode` stores the returned csrf via `setCsrf`.

- [ ] **Step 1: Write the failing pure-logic test**

```typescript
// dashboard/client/src/intake/intakeApi.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newIdempotencyKey, makeIntakeApi } from './intakeApi';

test('idempotency keys are unique non-empty strings', () => {
  const a = newIdempotencyKey(), b = newIdempotencyKey();
  assert.notEqual(a, b); assert.ok(a.length >= 8);
});

test('submitIntake sends credentials + X-CSRF-Token; exchangeCode captures csrf', async () => {
  const calls: any[] = [];
  let csrf = '';
  const fakeFetch = async (url: string, opts: any) => {
    calls.push({ url, opts });
    if (url.endsWith('/session')) return { ok: true, status: 200, json: async () => ({ csrfToken: 'CT', expiresAt: 1 }) } as any;
    return { ok: true, status: 201, json: async () => ({ id: 'INTAKE-1' }) } as any;
  };
  const api = makeIntakeApi({ fetchImpl: fakeFetch as any, getCsrf: () => csrf, setCsrf: (t) => { csrf = t; } });
  await api.exchangeCode('CODE');
  assert.equal(csrf, 'CT');
  await api.submitIntake({ title: 'x', body: 'y', idempotencyKey: 'k' });
  const submit = calls[1];
  assert.equal(submit.opts.credentials, 'include');
  assert.equal(submit.opts.headers['X-CSRF-Token'], 'CT');
  assert.match(submit.url, /\/api\/intake\/intakes$/);
});
```

- [ ] **Step 2: Run → fail**

Run: `cd dashboard/client && node --require ts-node/register --test src/intake/intakeApi.test.ts`
Expected: FAIL — module missing. (If ts-node isn't configured for the client, run via the repo's existing client test command — check `client/package.json` `test` script and mirror it; the client already has `tests/commandLogTime.test.ts` running under node's test runner.)

- [ ] **Step 3: Implement `intakeApi.ts`, `main.tsx`, `intake.html`, vite input, static serving**

`intakeApi.ts`: a `req(method, path, { body, raw, filename })` helper that always sets `credentials:'include'`, sets `content-type: application/json` for JSON bodies, and adds `X-CSRF-Token: getCsrf()` on POST/PUT/PATCH/DELETE. `exchangeCode` POSTs `/api/intake/session {code}` and calls `setCsrf(res.csrfToken)`. `uploadAttachment` sends the raw file body with `X-Filename` + `X-CSRF-Token`. `newIdempotencyKey` = `crypto.randomUUID()` (browser) with a fallback. Default `getCsrf/setCsrf` back an in-memory module variable (never localStorage).

`intake.html`: minimal HTML loading `src/intake/main.tsx`. `main.tsx`: `createRoot(...).render(<IntakeApp/>)`. `vite.config.ts`: add `build: { rollupOptions: { input: { main: 'index.html', intake: 'intake.html' } } }`.

Central static serving (`server/src/index.ts`): after the API routes, serve the built client so `/intake` (and its assets) load same-origin. `[PLAN-ASSUMPTION]`: `app.use(express.static(clientDistDir))` guarded by an env/flag, plus a `GET /intake` → send `intake.html`. Add a `.env.example` note that the tester origin must be in `DASHBOARD_ALLOWED_ORIGINS` (dev `http://localhost:3000`).

- [ ] **Step 4: Run test → pass; build; commit**

Run: `cd dashboard/client && node --require ts-node/register --test src/intake/intakeApi.test.ts` → PASS. Then `cd dashboard/client && npm run build` (both entries build) and `cd dashboard/server && npm run build`.

```bash
git add dashboard/client/intake.html dashboard/client/vite.config.ts dashboard/client/src/intake/main.tsx dashboard/client/src/intake/intakeApi.ts dashboard/client/src/intake/intakeApi.test.ts dashboard/server/src/index.ts dashboard/server/.env.example
git commit -m "feat(intake-ui): Vite intake entry + cookie/CSRF api client + static serving"
```

---

## Task 9: IntakeApp — code entry, form, My Intakes

**Files:**
- Create: `dashboard/client/src/intake/IntakeApp.tsx`
- Create: `dashboard/client/src/intake/components/CodeEntry.tsx`, `IntakeForm.tsx`, `MyIntakes.tsx`

**Interfaces:**
- Consumes: `makeIntakeApi` (Task 8), the server's `displayStatus` (rendered as-is — NO client status map), the product list from `getProducts()`.
- Produces: the rendered tester flow. React state machine: `unauthenticated` (CodeEntry) → `authenticated` (IntakeForm + MyIntakes). A 401 from any call resets to `unauthenticated`.

- [ ] **Step 1: Implement the components** (no unit test — verified via browser in Task 10; keep logic thin and delegate all I/O to `intakeApi`)

- `CodeEntry`: one input + submit → `api.exchangeCode(code)`; on 401 show "Invalid code"; on 429 show "Too many attempts, retry in N" (read `Retry-After`).
- `IntakeForm`: fields per the spec — Title (required), Product `<select>` from `getProducts()` + an "Other / not sure" option that submits an empty `productHint` (NO free-text product), Severity `<select>` (blocker/high/medium/low), Description (required), collapsible "More details" (Steps/Expected/Actual/Environment), Attachments file picker (client hint: PNG/JPEG/WebP/TXT/LOG ≤5 MB). On submit: generate `newIdempotencyKey()`, `api.submitIntake(...)`, then upload each attachment via `api.uploadAttachment(id, file)`; map 413/415/409/429 to friendly messages; refresh MyIntakes.
- `MyIntakes`: `api.listIntakes()` → render title/product/date/`displayStatus`. Selecting one shows the tester's own submitted content (from the projection). Render `displayStatus` verbatim — the component contains no state→label logic.
- `IntakeApp`: holds auth state + the `intakeApi` instance; renders CodeEntry or (IntakeForm + MyIntakes); a shared `Toast` for feedback; a logout button → `api.logout()` → back to CodeEntry.
- Reuse `styles/globals.css`; keep the layout clean/form-focused. Never render `state`, `tester_id`, triage, or a TASK id (the projection doesn't carry them).

- [ ] **Step 2: Build + commit**

Run: `cd dashboard/client && npm run build` (clean). Full backend suite still green: `cd dashboard/server && npm test`.

```bash
git add dashboard/client/src/intake/IntakeApp.tsx dashboard/client/src/intake/components
git commit -m "feat(intake-ui): tester submission flow (code entry, structured form, my intakes)"
```

---

## Task 10: Browser verification (end-to-end on localhost)

**Files:** none (verification only).

- [ ] **Step 1: Provision a tester access code + a product list**

```bash
cd dashboard/server && npm run intake:ops provision-admin --label local --caps intake:admin
```
Use the admin credential to `POST /api/intake/admin/codes` (issue a tester code), and set `INTAKE_PRODUCT_LIST` to a small example in the dev env. Set `INTAKE_ADMIN_AUTH_MODE=required` (a credential exists).

- [ ] **Step 2: Boot the dashboard and open `/intake`**

Start the dev server (`cd dashboard && npm run dev`) and open `/intake` in the in-app browser (preview tools). Confirm the code-entry screen renders.

- [ ] **Step 3: Exercise the full flow and verify redaction**

Exchange the tester code → submit a structured intake with one PNG attachment → confirm it appears in My Intakes with a friendly status. Using the browser network panel, inspect the `POST /api/intake/intakes`, `GET /api/intake/intakes`, and `GET /api/intake/intakes/:id` response bodies and confirm NONE contain `tester_id`, raw `state`, `revision`, `change_seq`, `idempotency_key`, or a `TASK-` id. Confirm a wrong code → generic "invalid code", and that logout without the CSRF token is rejected.

- [ ] **Step 4: Record evidence**

Capture a screenshot of the submitted flow + the redacted network responses; note them in the PR/handoff. No commit (verification task).

---

## Self-Review

**Spec coverage:** migration v5 + fields → Task 1; single `toTesterIntake` + server-side fail-closed status → Tasks 2–3; POST/list/detail projection (closes the leak) → Task 3; logout CSRF → Task 4; products endpoint + validated config + "Other"→empty → Tasks 5, 9; admin detail endpoint + `centralClient.getIntakeDetail` (M2 gap) → Task 6; promotion promo.v2 → Task 7; separate Vite entry + cookie/CSRF client + static serving + `DASHBOARD_ALLOWED_ORIGINS` → Task 8; the tester UI (code entry/form/My Intakes) → Task 9; browser verification incl. redaction → Task 10. Every spec section maps to a task.

**Placeholder scan:** no "TBD"/"add validation" — each code step has real code. The two integration tests in Tasks 3–5 describe the arrange/act against the file's existing code-exchange helper rather than re-deriving it; that helper already exists in `intake.integration.test.ts` (the M1 happy-path submit test), so it is a concrete reference, not a placeholder.

**Type consistency:** `IntakeRow`'s five new fields (Task 1) are consumed by `toTesterIntake` (Task 2) and `projectIntakeForPromotion` (Task 7) with matching snake_case column names; `TesterIntake`'s camelCase keys are the exact set asserted in Task 2 and rendered in Task 9; `makeIntakeApi`/`newIdempotencyKey` signatures (Task 8) are consumed by Task 9; `displayStatusFor` is defined once (Task 2) and never duplicated on the client.

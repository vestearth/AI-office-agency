# M5 — Owner Intake Review UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dashboard "Intake" Kanban board that lets the owner review incoming tester intakes and drive them through list → claim → triage → promote, filling the pre-promotion gap left by M1–M4.

**Architecture:** A new `/api/intake/review/*` router behind the dashboard bearer. Reads query the `intake` table directly (`reviewStore`); actions reuse the existing workflow functions **in-process** through a single `ReviewBackend` interface (the Phase B seam). The client is a new `IntakeView` board keyed by intake state with a detail+action drawer.

**Tech Stack:** Express + TypeScript + better-sqlite3 (server), React + Vite (client). Node built-in test runner — server via `ts-node/register`, client via `tsx`. No jest/vitest/jsdom.

Design spec: `docs/superpowers/specs/2026-07-25-intake-owner-review-ui-design.md`.

## Global Constraints

- **Auth (v1):** all `/api/intake/review/*` routes sit behind the dashboard bearer (`createAuthMiddleware`), mounted **after** `app.use('/api', ...)` — unlike `/api/local/*`. No intake admin credential.
- **Owner is server-derived:** `resolveOwner(officeRoot, config)` = `readEffectivePrefix` → `readTeamRegistry[prefix]` ?? `config.localMachineId`. Never read `owner` from the request body.
- **Reads never spread a raw row:** use the explicit `toReviewIntake` projection (owner-facing full fields). Distinct from the tester `toTesterIntake`.
- **Actions reuse existing functions in-process** — `claimIntake`, `releaseClaim`, `classifyScope`+`buildTriagePackage`, `validateTriageResult`+`importTriageResult`, `checkPromotionGate`+`promoteIntake`+`recordPromotion`. Do not reimplement state transitions.
- **Optimistic concurrency:** every mutating action takes `expectedRevision`; a mismatch returns HTTP 409 `{error, reason:'revision_conflict'}`.
- **Claim TTL:** `config.claimTtlMs` (default 30 min). No auto-renew in v1.
- **Triage schema:** `triage.v1`; classifications `triaged | needs_scope_review | ai_failed`. The owner-entered triage-result carries `contextHash` from the triage-package response.
- **State → column map:** Inbox=`submitted`; Needs attention=`needs_scope_review`,`ai_failed`; Ready=`triaged`; Promoted=`promoted`. `closed` filtered out; `decided` never rendered.
- **Promotion writes** `TASK-<PREFIX>-NNN` via `promoteIntake` (validate-then-rollback) with an in-process `recordPromotion` adapter; `taskPrefix` comes from the request, validated against the team registry.

---

### Task 1: reviewStore — list query + detail projection

**Files:**
- Create: `dashboard/server/src/intake/reviewStore.ts`
- Test: `dashboard/server/src/intake/reviewStore.test.ts`

**Interfaces:**
- Consumes: `DB` (`./db`), `IntakeRow`/`getIntake` (`./intakeStore`), `getActiveClaim` (`./claimStore`), `getLatestTriage` (`./triageStore`).
- Produces:
  - `listReviewIntakes(db, opts: { state?: string; includeClosed?: boolean }, now: number): { intakes: ReviewIntakeSummary[]; counts: Record<string, number> }`
  - `getReviewDetail(db, id: string, now: number): ReviewIntakeDetail | null`
  - `toReviewIntake(row, extra): ReviewIntakeDetail`
  - types `ReviewIntakeSummary`, `ReviewIntakeDetail`, `ReviewClaim`

- [ ] **Step 1: Write the failing test**

```ts
// reviewStore.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { submitIntake } from './intakeStore';
import { claimIntake } from './claimStore';
import { listReviewIntakes, getReviewDetail } from './reviewStore';

function seed(db: ReturnType<typeof openDb>) {
  const t = db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)');
  t.run('TSTR-1', 'QA A', 1);
  return submitIntake(db, { testerId: 'TSTR-1', title: 'Login crash', body: 'crashes',
    severity: 'high', reproSteps: 'rotate', expected: 'stays', actual: 'white', environment: 'iOS' }).intake;
}

test('listReviewIntakes returns summaries with counts and active-claim badge', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const intake = seed(db);
  const now = 1000;
  const before = listReviewIntakes(db, {}, now);
  assert.equal(before.intakes.length, 1);
  assert.equal(before.intakes[0].state, 'submitted');
  assert.equal(before.intakes[0].severity, 'high');
  assert.equal(before.intakes[0].claim, undefined);
  assert.equal(before.counts.submitted, 1);

  claimIntake(db, { intakeId: intake.id, owner: 'earth', expectedRevision: intake.revision, now, ttlMs: 60_000 });
  const after = listReviewIntakes(db, {}, now + 1);
  assert.equal(after.intakes[0].claim?.owner, 'earth');
  assert.equal(after.intakes[0].claim?.expiresAt, now + 60_000);
});

test('listReviewIntakes filters by state and hides closed unless asked', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const intake = seed(db);
  db.prepare('UPDATE intake SET state = ? WHERE id = ?').run('closed', intake.id);
  assert.equal(listReviewIntakes(db, {}, 1).intakes.length, 0);            // closed hidden
  assert.equal(listReviewIntakes(db, { includeClosed: true }, 1).intakes.length, 1);
  assert.equal(listReviewIntakes(db, { state: 'submitted' }, 1).intakes.length, 0);
});

test('getReviewDetail returns the full owner-facing intake with no extra columns', () => {
  const db = openDb(':memory:'); runMigrations(db);
  const intake = seed(db);
  const detail = getReviewDetail(db, intake.id, 1)!;
  assert.equal(detail.reproSteps, 'rotate');
  assert.equal(detail.environment, 'iOS');
  assert.deepEqual(
    Object.keys(detail).sort(),
    ['activeClaim','actual','attachments','body','createdAt','environment','expected','hasTriage','id','latestTriage','productHint','reproSteps','revision','severity','state','title','updatedAt'].sort()
  );
  assert.equal(getReviewDetail(db, 'nope', 1), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/reviewStore.test.ts`
Expected: FAIL — `reviewStore` has no exported members.

- [ ] **Step 3: Write minimal implementation**

```ts
// reviewStore.ts
import type { DB } from './db';
import { getIntake } from './intakeStore';
import { getActiveClaim } from './claimStore';
import { getLatestTriage } from './triageStore';

export interface ReviewClaim { owner: string; expiresAt: number; }
export interface ReviewIntakeSummary {
  id: string; title: string; severity: string | null; productHint: string | null;
  state: string; revision: number; createdAt: number; updatedAt: number;
  claim?: ReviewClaim; hasTriage: boolean;
}
export interface ReviewIntakeDetail extends ReviewIntakeSummary {
  body: string; reproSteps: string | null; expected: string | null;
  actual: string | null; environment: string | null;
  attachments: { id: string; name: string; bytes: number }[];
  latestTriage: object | null; activeClaim: ReviewClaim | null;
}

const HIDDEN_BY_DEFAULT = new Set(['closed']);

export function listReviewIntakes(
  db: DB, opts: { state?: string; includeClosed?: boolean }, now: number
): { intakes: ReviewIntakeSummary[]; counts: Record<string, number> } {
  const rows = db.prepare(
    `SELECT i.id, i.title, i.severity, i.product_hint AS productHint, i.state,
            i.revision, i.created_at AS createdAt, i.updated_at AS updatedAt,
            EXISTS(SELECT 1 FROM triage_result tr WHERE tr.intake_id = i.id) AS hasTriage
       FROM intake i ORDER BY i.created_at DESC`
  ).all() as (Omit<ReviewIntakeSummary,'claim'|'hasTriage'> & { hasTriage: number })[];

  const counts: Record<string, number> = {};
  const intakes: ReviewIntakeSummary[] = [];
  for (const r of rows) {
    counts[r.state] = (counts[r.state] ?? 0) + 1;
    if (!opts.includeClosed && HIDDEN_BY_DEFAULT.has(r.state)) continue;
    if (opts.state && r.state !== opts.state) continue;
    const claim = getActiveClaim(db, r.id, now);
    intakes.push({
      ...r, hasTriage: !!r.hasTriage,
      claim: claim ? { owner: claim.owner, expiresAt: claim.expires_at } : undefined,
    });
  }
  return { intakes, counts };
}

export function getReviewDetail(db: DB, id: string, now: number): ReviewIntakeDetail | null {
  const row = getIntake(db, id);
  if (!row) return null;
  const claim = getActiveClaim(db, id, now);
  const activeClaim = claim ? { owner: claim.owner, expiresAt: claim.expires_at } : null;
  const attachments = db.prepare(
    'SELECT id, original_name AS name, byte_size AS bytes FROM attachment WHERE intake_id = ?'
  ).all(id) as { id: string; name: string; bytes: number }[];
  const latestTriage = getLatestTriage(db, id);
  return {
    id: row.id, title: row.title, severity: row.severity, productHint: row.product_hint,
    state: row.state, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
    claim: activeClaim ?? undefined, hasTriage: !!latestTriage,
    body: row.body, reproSteps: row.repro_steps, expected: row.expected,
    actual: row.actual, environment: row.environment,
    attachments, latestTriage, activeClaim,
  };
}
```

> **Interface check before coding:** confirm the `attachment` table's size/name columns (`original_name`, `byte_size`) via `intake/migrations.ts`; if they differ, use the real column names. The test only asserts the top-level `attachments` key exists, so an empty result is fine when no attachments are seeded.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/server && node --require ts-node/register --test src/intake/reviewStore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/server/src/intake/reviewStore.ts dashboard/server/src/intake/reviewStore.test.ts
git commit -m "feat(intake-review): reviewStore list query + owner-facing detail projection"
```

---

### Task 2: ReviewBackend interface + InProcessReviewBackend

**Files:**
- Create: `dashboard/server/src/local/reviewBackend.ts`
- Test: `dashboard/server/src/local/reviewBackend.test.ts`

**Interfaces:**
- Consumes: `reviewStore` (Task 1); `claimIntake`/`releaseClaim` (`../intake/claimStore`); `classifyScope`/`resolveAllowedRepos`/`captureProvenance` (`./repoProvenance`); `buildTriagePackage` (`./triagePackage`); `validateTriageResult` (`../intake/triageSchema`); `importTriageResult` (`../intake/triageStore`); `checkPromotionGate` (`./triageGate`); `promoteIntake` (`./promotion`); `recordPromotion` (`../intake/promotionRecordStore`); `getIntake` (`../intake/intakeStore`); `intakeConfig` (`../intake/config`); `readEffectivePrefix`/`readTeamRegistry` (`../services/identity`).
- Produces:
  - `interface ReviewBackend { list; detail; claim; release; triagePackage; recordTriage; promote }` (exact method sigs in Step 3)
  - `makeInProcessReviewBackend(db, deps: { runsDir: string; officeRoot: string; now?: () => number; validate?: (taskId: string) => Promise<{ ok: boolean }> }): ReviewBackend`
  - `resolveOwner(officeRoot: string, localMachineId: string): Promise<string>`

- [ ] **Step 1: Write the failing test**

```ts
// reviewBackend.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../intake/db';
import { runMigrations } from '../intake/migrations';
import { submitIntake } from '../intake/intakeStore';
import { makeInProcessReviewBackend } from './reviewBackend';

function setup() {
  const db = openDb(':memory:'); runMigrations(db);
  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)').run('TSTR-1', 'QA', 1);
  const intake = submitIntake(db, { testerId: 'TSTR-1', title: 'Coin wrong', body: 'balance off' }).intake;
  const be = makeInProcessReviewBackend(db, {
    runsDir: '/tmp/does-not-matter', officeRoot: '/tmp', now: () => 1000,
    validate: async () => ({ ok: true }),
  });
  return { db, intake, be };
}

test('claim rejects a stale revision with revision_conflict', async () => {
  const { intake, be } = setup();
  const bad = await be.claim(intake.id, intake.revision + 5);
  assert.equal(bad.ok, false);
  assert.equal((bad as any).reason, 'revision_conflict');
  const good = await be.claim(intake.id, intake.revision);
  assert.equal(good.ok, true);
});

test('recordTriage rejects an invalid payload and accepts a valid triaged result', async () => {
  const { db, intake, be } = setup();
  const bad = await be.recordTriage(intake.id, intake.revision, { schemaVersion: 'nope' });
  assert.equal(bad.ok, false);
  const ok = await be.recordTriage(intake.id, intake.revision,
    { schemaVersion: 'triage.v1', classification: 'triaged', summary: 's', contextHash: 'h' });
  assert.equal(ok.ok, true);
  assert.equal((db.prepare('SELECT state FROM intake WHERE id=?').get(intake.id) as any).state, 'triaged');
});

test('promote is blocked without triage and writes a TASK dir once triaged', async () => {
  const { intake, be } = setup();
  const blocked = await be.promote(intake.id, intake.revision, { prefix: 'EAR' });
  assert.equal(blocked.ok, false); // gate_blocked (no triage, no override)

  await be.recordTriage(intake.id, intake.revision,
    { schemaVersion: 'triage.v1', classification: 'triaged', summary: 's', contextHash: 'h' });
  const fresh = (await be.detail(intake.id))!;
  const promoted = await be.promote(intake.id, fresh.revision, { prefix: 'EAR' });
  assert.equal(promoted.ok, true);
  assert.match((promoted as any).taskId, /^TASK-EAR-\d+$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/server && node --require ts-node/register --test src/local/reviewBackend.test.ts`
Expected: FAIL — `makeInProcessReviewBackend` not exported.

> The promote test writes a real `runsDir`. Point it at a temp dir the test owns (`node:fs.mkdtempSync(os.tmpdir()+'/rev-')`) and pass that as `runsDir` so the test is hermetic; delete it in a `finally`. Update the `setup()` above to create and return that temp dir.

- [ ] **Step 3: Write minimal implementation**

```ts
// reviewBackend.ts
import type { DB } from '../intake/db';
import { listReviewIntakes, getReviewDetail, type ReviewIntakeSummary, type ReviewIntakeDetail } from '../intake/reviewStore';
import { getIntake } from '../intake/intakeStore';
import { claimIntake, releaseClaim, getActiveClaim } from '../intake/claimStore';
import { classifyScope, resolveAllowedRepos, captureProvenance } from './repoProvenance';
import { buildTriagePackage } from './triagePackage';
import { validateTriageResult } from '../intake/triageSchema';
import { importTriageResult, getLatestTriage } from '../intake/triageStore';
import { checkPromotionGate } from './triageGate';
import { promoteIntake } from './promotion';
import { recordPromotion } from '../intake/promotionRecordStore';
import { intakeConfig } from '../intake/config';
import { readEffectivePrefix, readTeamRegistry } from '../services/identity';

type Result<T> = ({ ok: true } & T) | ({ ok: false; reason: string; errors?: string[] });

export interface ReviewBackend {
  list(opts: { state?: string; includeClosed?: boolean }): Promise<{ intakes: ReviewIntakeSummary[]; counts: Record<string, number> }>;
  detail(id: string): Promise<ReviewIntakeDetail | null>;
  claim(id: string, expectedRevision: number): Promise<Result<{ claim: { owner: string; expiresAt: number } }>>;
  release(id: string): Promise<Result<{}>>;
  triagePackage(id: string): Promise<Result<{ needsScopeReview?: boolean; contextHash?: string; repos?: string[]; manifest?: object }>>;
  recordTriage(id: string, expectedRevision: number, raw: unknown): Promise<Result<{ state: string }>>;
  promote(id: string, expectedRevision: number, opts: { prefix: string; overrideReason?: string }): Promise<Result<{ taskId: string }>>;
}

export async function resolveOwner(officeRoot: string, localMachineId: string): Promise<string> {
  const eff = await readEffectivePrefix(officeRoot);
  const registry = await readTeamRegistry(officeRoot);
  return (eff.taskPrefix && registry[eff.taskPrefix]) || localMachineId;
}

export function makeInProcessReviewBackend(
  db: DB,
  deps: { runsDir: string; officeRoot: string; now?: () => number; validate?: (taskId: string) => Promise<{ ok: boolean }> }
): ReviewBackend {
  const now = deps.now ?? (() => Date.now());
  const owner = () => resolveOwner(deps.officeRoot, intakeConfig.localMachineId);

  return {
    async list(opts) { return listReviewIntakes(db, opts, now()); },
    async detail(id) { return getReviewDetail(db, id, now()); },

    async claim(id, expectedRevision) {
      const r = claimIntake(db, { intakeId: id, owner: await owner(), expectedRevision, now: now(), ttlMs: intakeConfig.claimTtlMs });
      return r.ok ? { ok: true, claim: { owner: r.claim.owner, expiresAt: r.claim.expires_at } } : { ok: false, reason: r.reason };
    },

    async release(id) {
      const claim = getActiveClaim(db, id, now());
      if (!claim) return { ok: false, reason: 'no_active_claim' };
      const r = releaseClaim(db, { claimId: claim.id, owner: await owner() });
      return r.ok ? { ok: true } : { ok: false, reason: 'release_failed' };
    },

    async triagePackage(id) {
      const intake = getIntake(db, id);
      if (!intake) return { ok: false, reason: 'not_found' };
      const scope = classifyScope(intake, resolveAllowedRepos(intakeConfig.intakeRepoAllowlist));
      if (scope.needsScopeReview) return { ok: true, needsScopeReview: true };
      const provenance = scope.repos
        .map((name) => intakeConfig.intakeRepoAllowlist.find((r) => r.name === name)!)
        .map((r) => captureProvenance(r.path, undefined, now(), intakeConfig.localMachineId));
      const pkg = buildTriagePackage({ intake, repos: scope.repos, provenance });
      return { ok: true, contextHash: pkg.contextHash, repos: scope.repos, manifest: pkg.manifest };
    },

    async recordTriage(id, expectedRevision, raw) {
      const validated = validateTriageResult(raw);
      if (!validated.ok) return { ok: false, reason: 'schema_invalid', errors: validated.errors };
      const r = importTriageResult(db, { intakeId: id, expectedRevision, raw, importer: await owner() });
      return r.ok ? { ok: true, state: r.state } : { ok: false, reason: r.reason, errors: r.errors };
    },

    async promote(id, expectedRevision, opts) {
      const intake = getIntake(db, id);
      if (!intake) return { ok: false, reason: 'not_found' };
      if (intake.revision !== expectedRevision) return { ok: false, reason: 'revision_conflict' };
      const latestTriage = getLatestTriage(db, id) as any;
      const gate = checkPromotionGate({ intakeState: intake.state, latestTriage, override: opts.overrideReason ? { reason: opts.overrideReason } : undefined });
      const r = await promoteIntake({
        intake, triage: latestTriage, gate, owner: await owner(), taskPrefix: opts.prefix,
        runsDir: deps.runsDir, now,
        validate: deps.validate ?? (async () => ({ ok: true })),
        central: { recordPromotion: (intakeId, body: any) => Promise.resolve(recordPromotion(db, { intakeId, taskId: body.taskId, projectionVersion: body.projectionVersion, gateOverridden: body.gateOverridden })) },
      });
      return r.ok ? { ok: true, taskId: r.taskId } : { ok: false, reason: r.reason };
    },
  };
}
```

> **Interface check before coding:** open `promotion.ts` for the exact `promoteIntake` input keys (`intake`, `triage`, `gate`, `owner`, `taskPrefix`, `runsDir`, `now`, plus `PromoteDeps` = `validate?`, `central?`) and `captureProvenance` / `buildTriagePackage` / `classifyScope` signatures shown in the spec's Architecture section. Match them exactly. `checkPromotionGate` returns `{ allowed, reason, gateOverridden }` — pass the whole object as `gate`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/server && node --require ts-node/register --test src/local/reviewBackend.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/server/src/local/reviewBackend.ts dashboard/server/src/local/reviewBackend.test.ts
git commit -m "feat(intake-review): ReviewBackend interface + in-process implementation"
```

---

### Task 3: review router + mount + shared types

**Files:**
- Create: `dashboard/server/src/routes/intake/review.ts`
- Modify: `dashboard/server/src/index.ts` (mount after the `/api` bearer guard)
- Modify: `dashboard/shared/types.ts` (export the review types for the client)
- Test: `dashboard/server/src/routes/intake/review.integration.test.ts`

**Interfaces:**
- Consumes: `makeInProcessReviewBackend` (Task 2); `express` `Router`, `json`.
- Produces: `mountReviewRoutes(app, db, { runsDir, officeRoot })` (or a `buildReviewRouter(backend)` returning a `Router`, mounted at `/api/intake/review`).

- [ ] **Step 1: Write the failing test** (route-level round trip — the boundary lesson)

```ts
// review.integration.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../../intake/db';
import { runMigrations } from '../../intake/migrations';
import { submitIntake } from '../../intake/intakeStore';
import { buildReviewRouter } from './review';
import { makeInProcessReviewBackend } from '../../local/reviewBackend';
import os from 'node:os'; import fs from 'node:fs';

function app(db: any, runsDir: string) {
  const a = express();
  a.use('/api/intake/review', buildReviewRouter(makeInProcessReviewBackend(db, { runsDir, officeRoot: os.tmpdir(), now: () => 1000, validate: async () => ({ ok: true }) })));
  return a;
}
async function j(a: any, method: string, path: string, body?: object) {
  const { default: request } = await import('supertest'); // or a fetch against a listen()ed server
  const r = request(a)[method.toLowerCase()](path);
  if (body) r.send(body);
  return r;
}

test('round trip: list → claim → triage → promote through the real routes', async () => {
  const db = openDb(':memory:'); runMigrations(db);
  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)').run('TSTR-1', 'QA', 1);
  const intake = submitIntake(db, { testerId: 'TSTR-1', title: 'X', body: 'y', severity: 'high' }).intake;
  const runsDir = fs.mkdtempSync(os.tmpdir() + '/rev-');
  const a = app(db, runsDir);
  try {
    const list = await j(a, 'GET', '/api/intake/review/intakes');
    assert.equal(list.status, 200);
    assert.equal(list.body.intakes[0].severity, 'high'); // full field crosses the boundary

    const claim = await j(a, 'POST', `/api/intake/review/intakes/${intake.id}/claim`, { expectedRevision: intake.revision });
    assert.equal(claim.status, 200);

    const triage = await j(a, 'POST', `/api/intake/review/intakes/${intake.id}/triage-result`,
      { expectedRevision: intake.revision, result: { schemaVersion: 'triage.v1', classification: 'triaged', summary: 's', contextHash: 'h' } });
    assert.equal(triage.status, 200);

    const fresh = await j(a, 'GET', `/api/intake/review/intakes/${intake.id}`);
    const promote = await j(a, 'POST', `/api/intake/review/intakes/${intake.id}/promote`,
      { expectedRevision: fresh.body.revision, prefix: 'EAR' });
    assert.equal(promote.status, 201);
    assert.match(promote.body.taskId, /^TASK-EAR-\d+$/);
    assert.equal(fs.existsSync(runsDir + '/' + promote.body.taskId + '/task.md'), true);
  } finally { fs.rmSync(runsDir, { recursive: true, force: true }); }
});

test('stale revision on claim returns 409 revision_conflict', async () => {
  const db = openDb(':memory:'); runMigrations(db);
  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)').run('TSTR-1', 'QA', 1);
  const intake = submitIntake(db, { testerId: 'TSTR-1', title: 'X', body: 'y' }).intake;
  const a = app(db, fs.mkdtempSync(os.tmpdir() + '/rev-'));
  const r = await j(a, 'POST', `/api/intake/review/intakes/${intake.id}/claim`, { expectedRevision: intake.revision + 9 });
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'revision_conflict');
});
```

> If `supertest` is not already a dev dependency, use the repo's existing route-test approach (look at `intake.integration.test.ts` — it starts the app with `http.createServer(app).listen(0)` and uses `fetch`). Match whatever that file does; do not add a new dependency without checking.

- [ ] **Step 2: Run test to verify it fails** — `buildReviewRouter` missing. FAIL.

- [ ] **Step 3: Write minimal implementation**

```ts
// review.ts
import { Router, json } from 'express';
import type { ReviewBackend } from '../../local/reviewBackend';

const conflict = (reason: string) => reason === 'revision_conflict' || reason === 'already_claimed';

export function buildReviewRouter(backend: ReviewBackend): Router {
  const r = Router();
  r.use(json({ limit: '256kb' }));

  r.get('/intakes', async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const includeClosed = req.query.includeClosed === 'true';
    res.json(await backend.list({ state, includeClosed }));
  });

  r.get('/intakes/:id', async (req, res) => {
    const detail = await backend.detail(req.params.id);
    if (!detail) { res.status(404).json({ error: 'not found' }); return; }
    res.json(detail);
  });

  const action = (fn: (id: string, rev: number, body: any) => Promise<any>, okStatus = 200) =>
    async (req: any, res: any) => {
      const rev = Number(req.body?.expectedRevision);
      if (!Number.isInteger(rev)) { res.status(400).json({ error: 'expectedRevision required' }); return; }
      const out = await fn(req.params.id, rev, req.body);
      if (out.ok) { res.status(okStatus).json(out); return; }
      res.status(conflict(out.reason) ? 409 : out.reason === 'not_found' ? 404 : 422).json({ error: out.reason, reason: out.reason, errors: out.errors });
    };

  r.post('/intakes/:id/claim', action((id, rev) => backend.claim(id, rev)));
  r.post('/intakes/:id/release', async (req, res) => {
    const out = await backend.release(req.params.id);
    res.status(out.ok ? 200 : 409).json(out);
  });
  r.post('/intakes/:id/triage-package', async (req, res) => res.json(await backend.triagePackage(req.params.id)));
  r.post('/intakes/:id/triage-result', action((id, rev, body) => backend.recordTriage(id, rev, body.result)));
  r.post('/intakes/:id/promote', action((id, rev, body) => backend.promote(id, rev, { prefix: String(body.prefix ?? '').trim(), overrideReason: body.overrideReason }), 201));

  return r;
}
```

Mount in `index.ts` **after** `app.use('/api', createAuthMiddleware(...))`:

```ts
import { buildReviewRouter } from './routes/intake/review';
import { makeInProcessReviewBackend } from './local/reviewBackend';
// ...after the /api bearer guard and alongside runRoutes/eventRoutes:
app.use('/api/intake/review', buildReviewRouter(
  makeInProcessReviewBackend(getDb(), { runsDir: intakeConfig.runsDir, officeRoot: config.aiOfficeRoot })
));
```

> **Interface check before coding:** confirm the DB accessor used elsewhere in `index.ts` (`getDb()` from `./intake/db`), the runs dir on `intakeConfig` (`intakeConfig.runsDir`, default `AI_OFFICE_ROOT/runs`), and `config.aiOfficeRoot`. Add the review types (`ReviewIntakeSummary`, `ReviewIntakeDetail`, `ReviewClaim`) to `dashboard/shared/types.ts` by re-exporting or duplicating the shapes from `reviewStore.ts` following how other shared types are declared.

- [ ] **Step 4: Run test to verify it passes** — route round trip + 409. PASS.
- [ ] **Step 5: Run the full server suite** — `npm test`. Expected: all green (no regression; route mounted after the bearer guard).
- [ ] **Step 6: Commit**

```bash
git add dashboard/server/src/routes/intake/review.ts dashboard/server/src/routes/intake/review.integration.test.ts dashboard/server/src/index.ts dashboard/shared/types.ts
git commit -m "feat(intake-review): /api/intake/review routes (list/detail/claim/triage/promote) behind dashboard bearer"
```

---

### Task 4: client reviewApi + pure column logic

**Files:**
- Create: `dashboard/client/src/intake-review/reviewApi.ts`
- Create: `dashboard/client/src/intake-review/columns.ts`
- Test: `dashboard/client/src/intake-review/columns.test.ts`

**Interfaces:**
- Consumes: `apiFetchJson` (`../api`); shared review types.
- Produces:
  - `reviewApi` — `listIntakes`, `getDetail`, `claim`, `release`, `triagePackage`, `recordTriage`, `promote` (all via `apiFetchJson`).
  - `columns.ts` — `COLUMNS` (ordered), `columnForState(state): ColumnId | null`, `groupIntoColumns(intakes)`, `gateOpen(detail): boolean`, `claimRemainingMs(claim, now): number`.

- [ ] **Step 1: Write the failing test**

```ts
// columns.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnForState, groupIntoColumns, gateOpen } from './columns';

test('states map to the four working columns; closed/decided are not shown', () => {
  assert.equal(columnForState('submitted'), 'inbox');
  assert.equal(columnForState('needs_scope_review'), 'attention');
  assert.equal(columnForState('ai_failed'), 'attention');
  assert.equal(columnForState('triaged'), 'ready');
  assert.equal(columnForState('promoted'), 'promoted');
  assert.equal(columnForState('closed'), null);
  assert.equal(columnForState('decided'), null);
});

test('groupIntocolumns buckets summaries and drops non-column states', () => {
  const g = groupIntoColumns([
    { state: 'submitted' } as any, { state: 'triaged' } as any,
    { state: 'closed' } as any, { state: 'ai_failed' } as any,
  ]);
  assert.equal(g.inbox.length, 1);
  assert.equal(g.ready.length, 1);
  assert.equal(g.attention.length, 1);
  assert.equal(g.promoted.length, 0);
});

test('gateOpen requires a triaged latestTriage', () => {
  assert.equal(gateOpen({ latestTriage: { schemaVersion: 'triage.v1', classification: 'triaged' } } as any), true);
  assert.equal(gateOpen({ latestTriage: { classification: 'ai_failed' } } as any), false);
  assert.equal(gateOpen({ latestTriage: null } as any), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/client && npx tsx --test src/intake-review/columns.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// columns.ts
import type { ReviewIntakeSummary, ReviewIntakeDetail } from '../../../shared/types';

export type ColumnId = 'inbox' | 'attention' | 'ready' | 'promoted';
export const COLUMNS: { id: ColumnId; label: string }[] = [
  { id: 'inbox', label: 'Inbox' }, { id: 'attention', label: 'Needs attention' },
  { id: 'ready', label: 'Ready' }, { id: 'promoted', label: 'Promoted' },
];
const MAP: Record<string, ColumnId> = {
  submitted: 'inbox', needs_scope_review: 'attention', ai_failed: 'attention',
  triaged: 'ready', promoted: 'promoted',
};
export function columnForState(state: string): ColumnId | null { return MAP[state] ?? null; }

export function groupIntoColumns(intakes: ReviewIntakeSummary[]): Record<ColumnId, ReviewIntakeSummary[]> {
  const g: Record<ColumnId, ReviewIntakeSummary[]> = { inbox: [], attention: [], ready: [], promoted: [] };
  for (const i of intakes) { const c = columnForState(i.state); if (c) g[c].push(i); }
  return g;
}
export function gateOpen(detail: Pick<ReviewIntakeDetail, 'latestTriage'>): boolean {
  const t = detail.latestTriage as any;
  return !!t && t.schemaVersion === 'triage.v1' && t.classification === 'triaged';
}
export function claimRemainingMs(claim: { expiresAt: number } | null | undefined, now: number): number {
  return claim ? Math.max(0, claim.expiresAt - now) : 0;
}
```

```ts
// reviewApi.ts
import { apiFetchJson } from '../api';
import type { ReviewIntakeSummary, ReviewIntakeDetail } from '../../../shared/types';

const post = (path: string, body: object) => apiFetchJson(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

export const reviewApi = {
  listIntakes: (state?: string, includeClosed = false) =>
    apiFetchJson<{ intakes: ReviewIntakeSummary[]; counts: Record<string, number> }>(
      `/api/intake/review/intakes?${new URLSearchParams({ ...(state ? { state } : {}), includeClosed: String(includeClosed) })}`),
  getDetail: (id: string) => apiFetchJson<ReviewIntakeDetail>(`/api/intake/review/intakes/${id}`),
  claim: (id: string, expectedRevision: number) => post(`/api/intake/review/intakes/${id}/claim`, { expectedRevision }),
  release: (id: string) => post(`/api/intake/review/intakes/${id}/release`, {}),
  triagePackage: (id: string) => post(`/api/intake/review/intakes/${id}/triage-package`, {}),
  recordTriage: (id: string, expectedRevision: number, result: object) => post(`/api/intake/review/intakes/${id}/triage-result`, { expectedRevision, result }),
  promote: (id: string, expectedRevision: number, prefix: string, overrideReason?: string) => post(`/api/intake/review/intakes/${id}/promote`, { expectedRevision, prefix, overrideReason }),
};
```

> **Interface check before coding:** confirm `apiFetchJson`'s signature and how other client callers pass a JSON body (it may already set `Content-Type` / stringify — mirror an existing POST caller such as the identity or decision client, don't double-encode).

- [ ] **Step 4: Run test to verify it passes** — `npx tsx --test src/intake-review/columns.test.ts`. PASS (3 tests).
- [ ] **Step 5: Commit**

```bash
git add dashboard/client/src/intake-review/
git commit -m "feat(intake-review): client review API client + pure column/gate logic with tests"
```

---

### Task 5: IntakeView board + nav tab (read-only display)

**Files:**
- Create: `dashboard/client/src/views/IntakeView.tsx`
- Modify: `dashboard/client/src/views/types.ts` (add `'intake'` to `DashboardSection`)
- Modify: `dashboard/client/src/App.tsx` (register the `Intake` tab + render `IntakeView`)

**Interfaces:**
- Consumes: `reviewApi`, `columns` (Task 4); the dashboard's existing view shell patterns (mirror `KnowledgeReviewsView` for fetch/loading/error/refresh).

- [ ] **Step 1: Add `'intake'` to the section type**

```ts
// views/types.ts
export type DashboardSection = 'command' | 'monitor' | 'analytics' | 'reports' | 'review' | 'knowledge' | 'intake';
```

- [ ] **Step 2: Build the board (columns + cards + poll)**

Mirror `KnowledgeReviewsView`'s data-loading shape (`useCallback` loader, `refreshVersion`, loading/error states, `useDashboardRefresh`). Render `COLUMNS` as flex columns; for each, `groupIntoColumns(intakes)[col.id]` as cards. Card shows title, a severity dot (`high`→red), relative age, and a claim badge when `claim` is set. Clicking a card sets `selectedId` (drawer wired in Task 6). Empty/loading/error states rendered explicitly. Poll via the existing dashboard refresh hook (no SSE).

```tsx
// IntakeView.tsx (skeleton — fill in following KnowledgeReviewsView)
import { useCallback, useEffect, useState } from 'react';
import { reviewApi } from '../intake-review/reviewApi';
import { COLUMNS, groupIntoColumns } from '../intake-review/columns';
import type { ReviewIntakeSummary } from '../../../shared/types';

export function IntakeView() {
  const [intakes, setIntakes] = useState<ReviewIntakeSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    reviewApi.listIntakes()
      .then((r) => { setIntakes(r.intakes); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const grouped = groupIntoColumns(intakes);
  // render COLUMNS -> grouped[col.id] cards; onClick -> setSelectedId(card.id)
  // loading / error / empty states as in other views
  // <IntakeDrawer id={selectedId} onClose={...} onChanged={load} />  // Task 6
  return null; // replace with board JSX
}
```

- [ ] **Step 3: Register the tab in `App.tsx`**

Add `{ id: 'intake', label: 'Intake' }` to the `sections` array and render `<IntakeView />` when `activeSection === 'intake'`, following exactly how `knowledge`/`KnowledgeReviewsView` is wired.

- [ ] **Step 4: Type-check the client**

Run: `cd dashboard/client && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add dashboard/client/src/views/IntakeView.tsx dashboard/client/src/views/types.ts dashboard/client/src/App.tsx
git commit -m "feat(intake-review): Intake board view (read-only columns + cards) + nav tab"
```

---

### Task 6: Detail drawer + action wiring

**Files:**
- Create: `dashboard/client/src/intake-review/IntakeDrawer.tsx`
- Modify: `dashboard/client/src/views/IntakeView.tsx` (mount the drawer, re-load on change)

**Interfaces:**
- Consumes: `reviewApi`, `gateOpen`, `claimRemainingMs` (Task 4); the toast hook used elsewhere (`useToast` from `../components/Toast`).

- [ ] **Step 1: Build the drawer**

On `id`, fetch `reviewApi.getDetail(id)`. Render full intake (title, severity, body, repro/expected/actual/environment), `attachments` names (no download), `latestTriage`, gate status via `gateOpen(detail)`, and the active claim badge with `claimRemainingMs`. Action controls, each sending `detail.revision` as `expectedRevision`:

- **Claim** (when unclaimed) / **Release** (when claimed by anyone).
- **Build triage package** → shows `needsScopeReview` warning or `{repos, contextHash}`; stores `contextHash`.
- **Record triage** form: classification `<select>` (`triaged`/`needs_scope_review`/`ai_failed`) + summary textarea → posts `{ schemaVersion:'triage.v1', classification, summary, contextHash }` (contextHash from the package step; if none, block with a hint to build the package first).
- **Promote**: disabled unless `gateOpen(detail)` or an override reason is filled; a TASK **prefix** `<select>` (wrap native select with the custom chevron per project convention) accompanies it. On success, toast the `taskId`.

- [ ] **Step 2: Handle 409 revision_conflict uniformly**

Wrap every action: on a rejected promise whose status is 409 (`reason==='revision_conflict'`), toast "Changed since you loaded — refreshing" and call `onChanged()` (re-fetches detail + list). Never silently retry. Disable each action button while its request is in flight (double-promote guard).

> **Interface check before coding:** confirm how `apiFetchJson` surfaces non-2xx (does it throw with a status? look at `IntakeApiError` in `client/src/intake/httpError.ts` and the existing `apiFetchJson` — reuse the same error shape so the 409 branch can read the status). Reuse, don't invent a new error type.

- [ ] **Step 3: Native select convention**

Every `<select>` in the drawer (classification, TASK prefix) must be wrapped with `appearance-none` + a `lucide` `chevron-down` overlay (`pointer-events-none`, right-aligned) — never a bare native select. Grep the file before committing to confirm no bare `<select>` remains.

- [ ] **Step 4: Type-check + full client/server suites**

```bash
cd dashboard/client && npx tsc --noEmit
cd dashboard/server && npm test
```
Expected: client type-clean; server suite green.

- [ ] **Step 5: Manual verification (preview)**

Start the dev servers, mint a code, submit an intake from `/intake`, then in the Intake tab: claim → build package → record `triaged` → promote, and confirm a `TASK-<PREFIX>-NNN` dir appears under `runs/`. Screenshot the board.

- [ ] **Step 6: Commit**

```bash
git add dashboard/client/src/intake-review/IntakeDrawer.tsx dashboard/client/src/views/IntakeView.tsx
git commit -m "feat(intake-review): detail drawer + claim/triage/promote actions with 409 handling"
```

---

## Self-Review Notes

- **Spec coverage:** board (T5) · list/detail (T1/T3) · claim/triage/promote (T2/T3/T6) · gate+override (T2/T6) · owner server-derived (T2) · redaction-free owner projection (T1) · Phase B seam `ReviewBackend` (T2) · state→column map (T4) · scope boundary honored (no AI generator, no SSE, no drag-drop, attachments names-only) — all mapped.
- **Type consistency:** `ReviewIntakeSummary`/`ReviewIntakeDetail`/`ReviewClaim` defined in `reviewStore.ts` (T1), re-exported in `shared/types.ts` (T3), consumed by client (T4–T6). `ColumnId` defined once (T4).
- **Interface-check callouts** are embedded per task because several exact column names and helper signatures (attachment size columns, `apiFetchJson` body handling, `promoteIntake` deps) must be confirmed against source before coding — the implementer verifies each rather than trusting the snippet.
```

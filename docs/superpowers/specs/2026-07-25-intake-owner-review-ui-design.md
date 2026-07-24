# M5 — Owner Intake Review UI — Design

**Status:** Approved (brainstorm complete 2026-07-25), ready for implementation plan
**Milestone:** M5 of the AI Dev Office Intake Board (M1–M4 shipped to `main`)

## Goal

Give the owner a dashboard UI to review incoming tester intakes and drive them
through the full workflow — **list → detail → claim → triage → promote** — from a
single Kanban board, instead of the current API/CLI-only path.

## Context

The Intake Board (M1–M4) has a tester submission UI (`/intake`) and a headless
owner workflow (`/api/local/*` + `intake:ops` CLI), but **no owner-facing GUI** to
browse or act on intakes before promotion. Today the owner must hand-drive the
Local API. Once promoted, an intake becomes a `TASK-<PREFIX>-NNN` run visible in
the existing dashboard views; M5 fills the gap **before** promotion.

The dashboard runs on the owner's machine as `role=both` (single-machine); M3
Phase B (cross-machine TLS Central↔Local) is deferred. M5 targets the
single-machine reality while keeping a clean seam for Phase B.

## Decisions

1. **Scope** — full workflow in one page (list → detail → claim → triage → promote).
2. **Data path (hybrid)** — reads query the `intake` table directly; actions reuse
   the existing workflow logic **in-process**. See Architecture.
3. **Actions are in-process, not HTTP-loopback** — the review routes call the same
   functions `/api/local/*` uses (`claimIntake`, `buildTriagePackage`,
   `importTriageResult`, `checkPromotionGate` + `promoteIntake`) directly. This is
   protocol-correct (claim protocol, triage gate, `promo.v2`, TASK- writing)
   without needing `INTAKE_CENTRAL_BASE_URL` loopback or an intake admin
   credential (which `/api/local/*` requires and which `makeCentralClient` needs a
   non-empty base URL for — a relative-URL fetch throws in Node).
4. **Layout** — Kanban board keyed by intake state (option B), card click opens a
   right-side detail+action drawer.
5. **Auth (v1)** — dashboard bearer is sufficient (the dashboard is the owner's
   machine). Intake capability checks are added only when Phase B crosses to a
   real Central. Recorded in the `ReviewBackend` seam.
6. **Owner identity is server-derived** — the `owner` for claim/promote comes from
   the dashboard `/api/identity` actor (fallback `localMachineId`), never from the
   client body (anti-spoof).
7. **`ReviewBackend` interface is the Phase B seam** — today `InProcessReviewBackend`
   (direct-DB reads + in-process workflow); Phase B swaps to a
   `CentralReviewBackend` (`makeCentralClient`) with no route or UI change.
8. **Triage v1 is owner-entered** — there is no AI triage generator in the repo.
   The owner records a triage result via a form (classification + summary); the
   build-triage-package step provides scope/repo context to inform it.

## Architecture

```
Client (IntakeView board) ──HTTP──> /api/intake/review/*  (dashboard bearer)
                                          │
                                   routes/intake/review.ts
                                          │
                                    ReviewBackend  ◄── Phase B seam
                                          │
                    ┌─────────────────────┴─────────────────────┐
                READ (direct DB)                     ACTIONS (in-process)
             reviewStore.list/detail        claimIntake · buildTriagePackage
             (intake + claim + triage)       importTriageResult · checkPromotionGate
                                                     promoteIntake → runs/TASK-
```

- **Read path** (`reviewStore.ts`): queries `intake` directly (LEFT JOIN active
  `claim`, triage presence), filtered by state — same pattern as Monitor reading
  `runs/`. Behind dashboard bearer.
- **Action path**: reuses the exact workflow functions in-process. Protocol
  behaviors (optimistic revision, TTL claims, promotion gate, forbidden-field
  denylist, validate-then-rollback TASK- writing) are unchanged.
- **`ReviewBackend`**: a single interface (`list`, `detail`, `claim`, `release`,
  `triagePackage`, `recordTriage`, `promote`). `InProcessReviewBackend` implements
  it today; the read path's direct-DB coupling is isolated here and in
  `reviewStore.ts` so Phase B can substitute `CentralReviewBackend`.

## Backend API — `/api/intake/review/*` (dashboard bearer)

**Read (direct-DB):**

| Endpoint | Returns |
|---|---|
| `GET /review/intakes?state=&claimed=` | `{ intakes: ReviewIntakeSummary[], counts: Record<state, number> }` |
| `GET /review/intakes/:id` | `ReviewIntakeDetail` — full intake + `latestTriage` + `activeClaim` |

`ReviewIntakeSummary` = `{ id, title, severity, productHint, state, revision, createdAt, updatedAt, claim?: {owner, expiresAt}, hasTriage }`.
`ReviewIntakeDetail` adds `{ body, reproSteps, expected, actual, environment, attachments: {id,name,bytes}[], latestTriage, activeClaim }` via an explicit `toReviewIntake` projection (owner-facing, full — never a raw-row spread; distinct from the tester `toTesterIntake`).

**Actions (in-process workflow; every action sends the UI's `expectedRevision`):**

| Endpoint | Reuses | Notes |
|---|---|---|
| `POST /review/intakes/:id/claim` | `claimIntake` | owner server-derived; TTL 30m; 409 `revision_conflict` on stale rev |
| `POST /review/intakes/:id/release` | `releaseClaim` | |
| `POST /review/intakes/:id/triage-package` | `classifyScope` + `buildTriagePackage` | returns `{needsScopeReview:true}` on ambiguous/empty scope instead of throwing |
| `POST /review/intakes/:id/triage-result` | `validateTriageResult` + `importTriageResult` | body = owner-entered triage (classification + summary + contextHash); `importer` = owner |
| `POST /review/intakes/:id/promote` | `checkPromotionGate` + `promoteIntake` | body carries TASK `prefix`; 409 with `reason` when gate locked; writes `TASK-<PREFIX>-NNN` (validate-then-rollback) |

## State → column mapping

Intake states: `submitted · triaged · needs_scope_review · ai_failed · decided · promoted · closed`. Triage sets state to its classification; promote sets `promoted`.

| Column | State(s) | Primary action |
|---|---|---|
| 📥 **Inbox** | `submitted` | Claim → build/record triage |
| ⚠️ **Needs attention** | `needs_scope_review`, `ai_failed` | resolve scope (repo picker) / retry triage |
| ✅ **Ready** | `triaged` | Promote (gate open) |
| 🚀 **Promoted** | `promoted` | read-only + link to `TASK-` |

- `closed` — hidden behind a filter toggle (not a working column).
- `decided` — reserved; no current code produces it; not shown.
- **Claim is orthogonal** to state (a `claim` row) — shown as a card badge, not a column.

## UI — `IntakeView` (Kanban board + drawer)

- Four columns as above; each card shows title, severity (🔴 high), age, and a
  claim badge ("claimed by X · ~Nm left") when active.
- **Click a card → right drawer**: full intake detail, `latestTriage`, gate status
  (🔒 `triage_required` / 🔓 open), and state-appropriate action buttons. Cards are
  **not** drag-moved — actions transition state.
- **Claim** is an explicit button; **Promote** is locked until the gate opens
  (`triaged`) or an override reason is entered; a TASK **prefix** dropdown
  (validated against `office.team.yaml`) accompanies Promote.
- Refresh is **poll-based** (no SSE in v1).
- Empty / loading / backend-down states rendered explicitly, consistent with other
  views.
- New nav tab `Intake` (`DashboardSection` gains `'intake'`).

## Authz · concurrency · errors · redaction

- **Redaction/authz** — owner sees the full intake via `toReviewIntake` (not the
  tester redaction). v1 authz = dashboard bearer. Promotion still runs
  `assertNoForbiddenFields` / `FORBIDDEN_KEYS` before writing team-synced `runs/`.
- **Optimistic concurrency** — every action carries `expectedRevision`; on 409
  `revision_conflict` the UI toasts "changed — refreshing", refetches that card,
  and requires a fresh click (no silent retry).
- **Claim TTL (30m)** — badge shows remaining time; expired claims are reclaimable;
  an action after expiry returns conflict → re-claim (no auto-renew in v1).
- **Error surfaces** — `needsScopeReview` → repo picker from `INTAKE_REPO_ALLOWLIST`
  (empty allowlist → "set INTAKE_REPO_ALLOWLIST"); `ai_failed` → retry triage;
  gate fail → inline `reason`; promote failure leaves no lingering run.
- **Double-promote guard** — button disabled in-flight; server transaction checks
  `state !== 'promoted'`. Single-operator race accepted (no distributed lock).

## File structure

**Server** (behind `/api` dashboard bearer):
- `intake/reviewStore.ts` 🆕 — list query + `toReviewIntake` projection
- `local/reviewBackend.ts` 🆕 — `ReviewBackend` interface + `InProcessReviewBackend`
- `routes/intake/review.ts` 🆕 — `/api/intake/review/*` router; mounted in
  `index.ts` **after** the `/api` bearer guard (unlike `/api/local`)
- `shared/types.ts` — `ReviewIntakeSummary` / `ReviewIntakeDetail` / column types

**Client:**
- `views/IntakeView.tsx` 🆕 — the board + drawer
- `intake-review/reviewApi.ts` 🆕 — API client via `apiFetchJson`
- `intake-review/columns.ts` 🆕 — pure state→column grouping + gate-enabled logic
- `views/types.ts` — add `'intake'` to `DashboardSection`; `App.tsx` — register tab

## Testing

- **Server route-level integration** (per the "round-trip every boundary field
  through the real handler" lesson): list → claim → triage-result → promote through
  the actual routes; assert TASK- written, state transitions, `revision_conflict`
  (409), and gate lock/override.
- **Server unit**: `reviewStore` list/projection (assert no columns leak beyond the
  projection), `ReviewBackend` in-process wiring.
- **Client**: `reviewApi` + `columns.ts` pure logic via `tsx --test`.
- Node built-in test runner; server via `ts-node/register`, client via `tsx` (no
  jest/vitest, no jsdom — board is validated through pure helpers, not DOM render).

## Scope boundary

**In scope (v1):** Kanban board, claim, build-triage-package (scope/repo display),
owner-entered triage-result form, promote with gate + override, TASK prefix
dropdown, poll refresh.

**Out of scope (v1):** AI triage generator (none in repo — owner enters/imports the
result), live SSE updates, drag-drop between columns, closed-state management beyond
a filter, attachment **download** (existing route is tester-session-gated — the
drawer shows attachment names/count only).

## Phase B forward-compatibility

The UI only ever talks to same-origin `/api/intake/review/*`. When cross-machine
lands, `InProcessReviewBackend` is replaced by a `CentralReviewBackend` built on
`makeCentralClient`, and intake capability checks are added at the route — no UI
contract change. The only single-machine coupling (direct-DB reads) is isolated in
`reviewStore.ts` and `InProcessReviewBackend`.

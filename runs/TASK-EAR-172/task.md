# TASK-EAR-172 — Wire Purchase → Special Pass / Limited Avatar to the existing ledger

## Type

feature

## Workstream

backend

## Priority

medium

## Created

2026-07-29

## Context

Follow-up to TASK-EAR-163, which found that this needs **no design work** —
the purchase flow and its ledger already exist and are production-grade. Full
evidence: `runs/TASK-EAR-163/design-findings.md`.

Corrects TASK-EAR-158, whose conclusion that "no service anywhere records a
Special Pass/Limited Avatar purchase" was **wrong** — it searched
Games-Labs-Order (where the *catalog* lives) and missed Missions.

What exists:

- `Games-Labs-Missions/internal/services/store_service.go`
  `executeStorePurchase` — reserve/debit/complete state machine, server-derived
  deterministic wallet idempotency key, key-reuse rejection, resume-on-retry,
  avatar ownership guard, VIP gate.
- `store_purchase_operations` (`migrations/046_canonical_store_item_operations.sql`)
  — its own `COMMENT ON TABLE` calls it a *"Durable user-scoped Pass/Avatar
  purchase ledger"*. Columns already map onto the two sub-tabs:
  `user_id`, `item_type CHECK IN ('pass','avatar')`, `item_name`,
  `price_diamonds`, `created_at`, `state`, plus `pass_type`,
  `duration_seconds`, `is_permanent`.

**The only gap:** no list-by-user read path. Every query on that table
(`internal/repositories/store_repo.go`) is `INSERT` (:251), two `UPDATE`s
(:335, :475), and two `SELECT`s (:279, :440) that are **both single-row
lookups by `(user_id, operation_key)`** for idempotency resume and row
locking. There is no pagination precedent in that file at all.

## Objective

Expose the ledger read-only per player and wire the Player Detail page's
Purchase → **Special Pass** and **Limited Avatar** sub-tabs to it, replacing
mock data. Same shape as TASK-EAR-159.

## Scope

1. **Games-Labs-Missions** — new paginated repository query + service method +
   admin handler: list `store_purchase_operations` by `user_id`, filtered to
   `state = 'completed'` (only settled purchases are history; `reserved` and
   `debited` are in-flight and must not appear as completed purchases), with
   `item_type` filter and a total count. Note there is no LIMIT/OFFSET
   precedent in `store_repo.go` — follow the pagination convention used
   elsewhere in the repo (e.g. the paginated admin lists in `mission_repo.go`)
   rather than inventing one.
2. **shared-lib** — admin RPC + gateway binding. See the two traps below.
3. **api-gateway** — dependency bump; verify auto-wiring and route-order as in
   TASK-EAR-159/164.
4. **Games-Labs-backoffice** — wire the two sub-tabs, data-source-only per
   `preserve-ux-design-wire-data-only`. Mirror
   `useAdminPlayerPointHistory.ts`.

## ⚠️ Two traps that have each bitten this codebase before

**1. A Missions admin route needs a real proto `google.api.http` binding or it
404s through the gateway.** TASK-EAR-072 lost time to exactly this — routes
registered only on the Missions HTTP mux die at the gateway. Add the binding in
the proto, and if you add any by-id handler, do **not** read `r.PathValue()`:
the gRPC bridge bypasses the mux so it comes back `""` (TASK-EAR-046).

**2. JSON casing depends on the response type — check before wiring the FE.**
The existing `adminmissionpb` RPCs return `google.protobuf.Struct`
(`ListCheckInCampaigns`, `ListActivities`, `ListWeeklyActivities`, …), and
**Struct passthrough preserves snake_case**. A **typed** proto message instead
emits **camelCase** through grpc-gateway. TASK-EAR-076 shipped a bug from this
mismatch (backend emitted camelCase, FE read snake, values silently read as 0).
Decide deliberately which you are using, state it, and make the FE match the
actual wire format — verify against the generated swagger, not assumption.

## Acceptance criteria

- Purchase → Special Pass renders real rows where `item_type='pass'`; Limited
  Avatar renders `item_type='avatar'`. Both from
  `store_purchase_operations`, `state='completed'` only.
- Amount comes from `price_diamonds` and is labelled as Diamond — do not
  present it as an unlabelled number or imply THB.
- Pagination has a real total count, matching the page's existing
  `AdminDataTablePagination` usage.
- FE field casing verified against the generated swagger for the RPC actually
  added, not assumed.
- No template/markup changes — data source only.
- Build/vet/test clean in every touched service; backoffice build +
  typecheck at parity with baseline.
- Nothing committed/pushed/PR'd without operator confirmation. Branches cut
  from `origin/staging` for the Go services (`main` is stale there) and
  `main` for backoffice.

## Out of scope

- **Any change to the purchase flow itself.** It is live, load-bearing, and its
  idempotency design is stronger than a rewrite would be. Read-only work.
- **Retrofitting this into `orders` / `BUY_ITEM`.** TASK-EAR-163 settled this:
  it would duplicate a working idempotency design. The transaction stays in
  Missions; Order keeps the catalog.
- Whether the direct `wallet.Debit` on that path should route through Orders
  per the `USE_ORDERS_CATALOG` convention — flagged in TASK-EAR-163, already
  shipped, and a separate decision. Do not change it here.
- The Purchase → Package sub-tab (already wired, TASK-EAR-137) and everything
  else on the Detail page.

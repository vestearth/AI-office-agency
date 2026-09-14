# TASK-EAR-351 — Store Player Log Wave 2: historical completeness and Package payment gateway

## Type

feature (completeness + data reconstruction)

## Workstream

backend

## Priority

medium

## Created

2026-09-12

## Parent

TASK-EAR-346 (Wave 1, closed by operator 2026-09-11). Wave 1 guarantees
truthful **new** `store.purchase.settled` events on staging for Package,
Special Pass, and Limited Avatar. It deliberately deferred everything below
as "separately approved completeness". This run is that approval gate — each
item below is its own go/no-go, not a bundle.

## Goal

Close the residuals Wave 1 left explicit: historical Store rows still render
dashes for fields that were never stamped, Package `Payment Gateway` has no
authoritative source, and the Player Log username column shows the operator
account instead of the player. Every fix must keep the Wave 1 rule: never
infer a fact from a mutable catalog, a payment reference, or mock data.

## Current evidence (verified read-only 2026-09-12)

- **Wave 1 residuals recorded at close** (`runs/TASK-EAR-346/status.yaml`
  notes): historical dash, Package Payment Gateway persistence, SuperAdmin
  display-name quirk. Prod ECS/RDS untouched.
- **Contract already carries every field.**
  `shared-lib/events/player_activity.go` defines `PaymentGateway`,
  `PackageDisplayType`, `OriginalPrice *float64`, `TotalDiscount *float64`,
  `Complimentary *bool`, `ComplimentaryItems`, source reference types
  `store_purchase_pass` / `store_purchase_avatar`, and the sentinel
  `PlayerActivityPaymentGatewayNA = "N/A"`. No further contract change is
  needed for items A–C; item D may need one.
- **Order has no gateway column.** `Games-Labs-Order/migrations/004` adds
  only `payment_reference`; `internal/core/repositories/order.go` persists
  `payment_reference` and `wallet_reference`, nothing naming a provider.
  `internal/core/services/ordersvc/service_test.go:2161` asserts the
  package gateway *must stay empty* — that test is the Wave 1 guard and
  must be updated deliberately, not deleted, if item D ships.
- **Order's durable order rows are an authoritative reconstruction source.**
  `orders` persists `currency`, `package_snapshot`, `applied_coupon_code`,
  `discount_amount_minor_units`, `discount_currency`, `fulfilled_at`
  (`repositories/order.go:53`). This is the committed order record, not the
  mutable package catalog, so it is admissible under the Wave 1 rule.
- **Logs keeps the raw payload.** `monitoring_player_events` has a
  `payload String` column and `source_reference_type` filter
  (`Games-Labs-Logs/infrastructures/monitoring_clickhouse.go:92,647`), so
  a ClickHouse-only backfill can only ever surface fields the producer
  emitted at the time. Pre-Wave-1 Order payloads carried promotion code,
  original price, total discount, amount paid, and a complimentary boolean
  but NOT currency, gateway, complete assets, discount lines, or the
  complimentary reward snapshot (TASK-EAR-346 task.md, Current evidence).
- **Missions ledger is complete enough for Pass/Avatar.**
  `store_purchase_operations` (migration 046) holds `user_id`,
  `operation_key`, `canonical_item_id`, `item_type` (`pass`/`avatar`),
  `state`, `price_diamonds`, `item_name`, `pass_type`, `is_permanent`,
  `wallet_idempotency_key`, `created_at`, `updated_at`. Rows in state
  `completed` before the Wave 1 Missions deploy (Missions #130, staging
  2026-09-10) never produced a Store event.
- **Username quirk.** `runs/TASK-EAR-346/evidence/ev-020.log` shows
  `ui_username: SuperAdmin` on a Store row whose player is เดฟเทส
  (`fixture-matrix.json:29`). The row's `actor_*` columns exist in
  ClickHouse (`monitoring_clickhouse.go:104-107`); whether the UI binds
  actor name where it should bind player name is unverified.
- Staging Store tabs at close: Package 50, Pass 1, Avatar 1 (vault SPAR-28).

## Locked decisions (inherited from TASK-EAR-346, still binding)

- Stamp facts at purchase completion; never join current catalog state at
  Logs query time. A backfill reads a **durable ledger** (Order `orders`,
  Missions `store_purchase_operations`), never `packages`/catalog tables.
- Contracts extend additively; field numbers and existing clients preserved.
- Numeric presence: real zero ≠ absent. Backfilled rows must keep the same
  presence semantics as live rows.
- Package Type = immutable Custom/Default snapshot; `source_reference_type`
  stays provenance.
- Payment Gateway is `N/A` only for Diamond Wallet purchases. Package gateway
  stays absent until an authoritative provider is **persisted at checkout**;
  never derive it from `payment_reference` format.
- Wallet `spend.settled` never creates a Store row. A backfilled Pass/Avatar
  row must use the same deterministic event id the live producer would have
  emitted, so a later replay cannot double-insert.
- The Android client repo stays read-only. No production ECS/RDS startup.
  Prod data is out of scope until the operator starts a TASK-EAR-339-style
  supervised boot.

## Scope — four independently gated items

Each item needs its own explicit operator go before implementation. Default
order is A → B → C; D only if product confirms a source and vocabulary.

### A. Package historical re-projection (ClickHouse-retained fields only)

- Re-project existing `order`-typed rows from their stored `payload` into
  the Wave 1 read-model columns/mapper so fields that WERE emitted
  (promotion code, original price, total discount, amount paid,
  complimentary boolean) stop rendering as dashes.
- Fields never emitted stay dashes. Document the cutoff (first Wave 1 Order
  event id / timestamp on staging) in the UI coverage note or run evidence.
- Design question to answer FIRST: does the Logs mapper already read these
  fields from `payload` at query time? If yes, item A is a no-op and the
  dashes are purely missing-at-source — record that and skip to B.
- Idempotent, re-runnable, dry-run first with a row count diff.

### B. Pass/Avatar historical backfill from the Missions durable ledger

- One-off job (script or admin-only command, not a boot-time migration)
  that reads `store_purchase_operations WHERE state='completed' AND
  updated_at < <wave1_deploy_ts>` and emits `store.purchase.settled` with
  the live producer's deterministic event id and `DIAMOND` currency,
  `N/A` gateway, `price_diamonds`, canonical item id/name.
- Prove: dry-run count = expected; second run inserts 0; Wallet untouched;
  live Wave 1 rows (Pass 1 / Avatar 1 on staging) are not duplicated.
- Route through the same RabbitMQ publisher so Logs admission/dedupe
  (`monitoring_event_admissions`, EAR-343 key width 512) is exercised, not
  bypassed by a direct ClickHouse insert.

### C. Username column truthfulness (SuperAdmin quirk)

- Determine whether the Store table binds `actor_name` (operator) where the
  design intends the player's display name. Fix the binding in
  `Games-Labs-backoffice` or the Logs projection, whichever owns the
  defect. Preserve UX design; wire data only. Blank the cell rather than
  show the wrong identity if the player name is not available.

### D. Persisted Package payment-provider capture (needs product input)

- Prerequisite: product names the authoritative source (IAP receipt
  platform, PSP callback, client-declared field?) and the display
  vocabulary (Apple Pay / Google Pay / …).
- If approved: Order schema change (`payment_gateway` column) **with a
  migration in the same change**, stated deploy order and rollback;
  populate at `confirm-payment` from the authoritative source only;
  update — not delete — the Wave 1 guard test at
  `ordersvc/service_test.go:2161`; additive producer stamp; no backfill of
  historical gateway (never reconstructable).
- Without product input this item stays parked. Do not start it.

## Out / deferred

- Server-side money sorting and Store CSV export (Wave 1 deferred, still
  separate scope).
- Any production execution. Prod Store table is expected to show dashes until
  a prod train + supervised boot lands (see TASK-EAR-339).
- Android client changes.

## Acceptance criteria

- A: for the staging Package rows older than the Wave 1 cutoff, every field
  present in the stored payload renders; every absent field stays a dash;
  no row count changes; a re-run is a no-op.
- B: every pre-cutoff completed Pass/Avatar operation appears exactly once
  in its tab; totals match the ledger count; Wallet balances/transactions
  unchanged before vs after; re-run inserts 0.
- C: Store rows show the player's name (or blank), never the operator's
  login; ev-020-style fixture re-checked.
- D (only if approved): new Package purchase shows the persisted gateway;
  historical rows stay dash; Diamond rows stay `N/A`; migration replays
  idempotently on boot.
- Focused tests pass in every changed repo; no `replace` in `go.mod`;
  consumers build with `GOWORK=off go build -mod=readonly ./...`.
- Evidence per item: before/after raw API body + ClickHouse count + UI row.

## Release sequence (if A/B/C approved)

1. C (Backoffice or Logs only) — smallest, ships first.
2. A dry-run → apply on staging ClickHouse; record counts.
3. B dry-run against staging Missions ledger → publish; verify Logs
   admission and Wallet invariance.
4. D — separate release after product decision (shared-lib only if a new
   field is required, then Order → gateway pin if the wire format changes).

## Risks

- **Double rows on backfill:** deterministic event id + admission table is
  the guard; verify with a deliberate second run.
- **Catalog contamination:** any join to `packages`/store catalog tables in
  A or B is a no-ship. Ledger tables only.
- **Cutoff ambiguity:** derive the Wave 1 cutoff from the deployed image
  SHA's first event on staging, not from a date typed by hand.
- **Gateway fabrication (D):** `payment_reference` prefixes look like
  provider hints; they are not evidence. Parked until product answers.
- **Branch hygiene:** all six repos are clean on `staging`/`main` as of
  2026-09-12; start each item from refreshed base in a TASK-EAR-351 branch.

## Assignment

- Next agent: `pm` to triage; implementation lane `dev-2` after the
  operator gives per-item go (A/B/C first, D parked).
- Parallel: false. Items are independent but share the Logs read model —
  serialize A and B.
- Estimated complexity: medium (A/C), high (B), unknown (D).

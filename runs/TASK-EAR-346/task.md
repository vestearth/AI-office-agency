# TASK-EAR-346 — Complete Store Player Log table with authoritative purchase snapshots

## Type

feature

## Workstream

backend

## Priority

high

## Created

2026-09-10

## Goal

Make Monitoring → Player Log → Store show truthful, immutable purchase facts
for Package, Special Pass, and Limited Avatar. Each completed purchase must
appear once in the correct tab; missing facts remain explicitly unavailable and
must never be inferred from mutable catalogs, payment references, or mock data.

## Current evidence

- Runtime currently has 46 Package rows, but Currency, Payment Gateway, Asset,
  Promotion Code, discount details, Complimentary Item, Original Price, and
  Total Discount render as dashes.
- Changing to Special Pass changes only the heading; it continues to show the
  same Package rows because `activeTab` is absent from the API query.
- Backoffice hardcodes the missing values in
  `app/pages/admin/monitoring/player-log/store.vue`.
- `shared-lib/events.PlayerActivityEvent` already defines several commerce
  fields, but `monitoringpb.StoreLogDetail` and the Logs mapper expose only the
  six-field projection.
- Order publishes promotion code, original price, total discount, amount paid,
  and a complimentary boolean, but does not publish currency, payment gateway,
  complete assets, discount lines, or the complimentary reward snapshot.
- Completed Pass/Avatar purchases are durable in Missions
  `store_purchase_operations`; the existing admin history endpoint is per-user
  and is not a global monitoring source.
- Order has no authoritative Payment Gateway field. A payment reference is not
  sufficient evidence of Apple Pay, Google Pay, or another gateway.

## Locked decisions

- Stamp facts at purchase completion; never join current catalog state at Logs
  query time.
- Extend contracts additively and preserve existing field numbers and clients.
- Preserve numeric presence: a real zero is not the same as an absent value.
- Keep Order `source_reference_type=order` as provenance; do not display it as
  Package Type. Package Type is the immutable Custom/Default snapshot.
- Missions emits one deterministic `store.purchase.settled` event after a
  Pass/Avatar operation is completed. Wallet `spend.settled` remains a mission
  progress input and must not create a duplicate Store row.
- Package, Special Pass, and Limited Avatar tabs use server-side store-type
  filters and totals; tab switching must not reuse another tab's rows.
- Payment Gateway is `N/A` for Diamond Wallet purchases. Package gateway stays
  unavailable until an authoritative provider is captured and persisted; never
  infer it from `payment_reference`.
- Historical backfill is a separate Wave 2 decision. Wave 1 guarantees truthful
  new events and exposes only historical fields already present in raw payloads.
- `Games-Lab-Android/` remains read-only. No production ECS/RDS startup is in
  scope.

## Scope

In:

- `shared-lib`: additive player-activity/store monitoring contract and generated
  artifacts.
- `Games-Labs-Order`: immutable Package event enrichment.
- `Games-Labs-Missions`: completed Pass/Avatar Store event emission.
- `Games-Labs-Logs`: Store event projection, filtering, search, presence, and
  duplicate-safe reads.
- `api-gateway`: published `shared-lib` pin and HTTP JSON contract.
- `Games-Labs-backoffice`: field mapping, truthful formatting, and tab filters.
- Focused tests plus controlled staging acceptance.

Out / deferred:

- Historical Pass/Avatar backfill and reconstruction of facts not captured at
  event time.
- Adding an authoritative Package payment-provider field to checkout/order
  persistence unless the operator explicitly expands scope.
- Store CSV export and new non-date server-side sort support.
- Production first boot, production data validation, and Android changes.

## Delivery plan

### Wave 1 — truthful new events

1. **Contract first (`shared-lib`)**
   - Extend existing commerce event fields rather than create a parallel DTO.
   - Add the minimum fields needed for purchase kind, display type, assets with
     amounts/currency, promotion/discount detail, complimentary rewards, and
     explicit money presence.
   - Extend `StoreLogDetail` additively; regenerate protobuf, gateway, and
     Swagger artifacts and add contract tests.
   - Publish `shared-lib` before changing downstream module pins.
2. **Package producer (`Games-Labs-Order`)**
   - Populate currency, Custom/Default type, reward assets, promotion/discount
     snapshots, complimentary reward snapshot, and presence-aware prices from
     the committed order/package/coupon data.
   - Keep Payment Gateway absent unless an authoritative stored value exists.
   - Add focused producer tests for normal, discount, complimentary, and zero
     paid cases.
3. **Pass/Avatar producer (`Games-Labs-Missions`)**
   - After durable transition to `completed`, publish a deterministic Store
     purchase event from `store_purchase_operations` snapshot fields.
   - Use `DIAMOND`, the persisted final price, canonical item id/name, and
     source reference types `store_purchase_pass` / `store_purchase_avatar`.
   - Prove retry/idempotency does not create duplicate monitoring rows or a
     second Wallet debit.
4. **Read model (`Games-Labs-Logs`)**
   - Map the additive fields without fabricating missing values.
   - Admit Order and Missions `store.purchase.settled` events while excluding
     Wallet spend events from Store rows.
   - Support tab filters and search by player/purchase/item identifiers and
     item name. Add only additive ClickHouse columns/ALTERs that search or sort
     genuinely requires.
5. **HTTP and UI (`api-gateway`, `Games-Labs-backoffice`)**
   - Pin the published contract in gateway and verify protojson field names.
   - Map Package → `order`, Special Pass → `store_purchase_pass`, and Limited
     Avatar → `store_purchase_avatar` in the server query.
   - Replace hardcoded dashes with presence-aware formatting; show `N/A` only
     where the business flow truly has no payment gateway.

### Wave 2 — separately approved completeness

- Backfill eligible Package payload fields already retained in ClickHouse.
- Design and dry-run Pass/Avatar backfill from the Missions durable ledger.
- Add persisted Package payment-provider capture if product confirms the source
  and desired vocabulary.
- Add server-side money sorting and Store export only as separate acceptance
  scope.

## Acceptance criteria

- A normal Package row exposes correct item/type/currency/assets/original price,
  total discount zero, amount paid, purchase id, and no invented promotion.
- Discount and complimentary Package purchases expose their immutable code,
  classification, breakdown, and reward snapshot; zero paid remains `0`, not
  a dash.
- Completed Special Pass and Limited Avatar purchases appear exactly once and
  only in their respective tabs with DIAMOND price and `N/A` gateway.
- Tab totals, pagination, search, and date filtering are calculated on the
  selected type; switching tabs cannot reuse Package rows.
- Retrying an idempotent purchase does not create a second Store event or
  another Wallet mutation.
- Older rows with unavailable fields remain dashes and the coverage boundary is
  explicit; no catalog lookup silently rewrites history.
- Focused tests pass in every changed repository; `go.mod` and `go.sum` change
  together, contain no `replace`, and consumers build with
  `GOWORK=off go build -mod=readonly ./...`.
- Staging evidence traces each approved positive fixture through event payload,
  ClickHouse row, raw API response, and visible UI row. Production remains
  unverified and parked unless the operator separately starts it.

## Staging acceptance matrix

1. Package without promotion.
2. Package with discount code.
3. Package with complimentary rewards.
4. Special Pass purchased with Diamond.
5. Limited Avatar purchased with Diamond.
6. Repeat one idempotency key and prove one Store row plus wallet invariance.

Positive purchase fixtures, Wallet/Diamond effects, or data backfill require
explicit operator approval before execution.

## Release sequence

1. Merge and publish `shared-lib` to `main`.
2. Bump/test/deploy Logs and api-gateway on `staging`.
3. Bump/test/deploy Order and Missions on `staging`.
4. Merge/deploy Backoffice to `main`.
5. Run controlled staging acceptance and record raw before/after evidence.

## Risks

- **Contract/presence:** proto scalar zero can collapse absence and zero.
  Mitigation: optional fields or explicit presence flags with regression tests.
- **Duplicate events:** Wallet already emits Store-classified spend metadata.
  Mitigation: Store table consumes the canonical Store event only and uses a
  deterministic event id.
- **Historical incompleteness:** old events cannot reveal fields never emitted.
  Mitigation: preserve dashes, state cutoff, and keep backfill separately gated.
- **Payment Gateway fabrication:** no authoritative source exists today.
  Mitigation: absent for Package and `N/A` for Diamond flows until persistence
  is explicitly added.
- **Branch contamination:** the current Missions checkout is
  `task/TASK-EAR-342`. Implementation must start from refreshed
  `origin/staging` in a separate TASK-EAR-346 branch/worktree.

## Assignment

- Next agent: `dev-2`
- Parallel: false until `shared-lib` is published; downstream work may split by
  repository only after that contract gate.
- Estimated complexity: high

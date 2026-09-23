# TASK-EAR-376 — Expose redemption presentation metadata on owned items

## Origin

Mobile requested an additive response change on 2026-09-22. They need the
Backoffice-configured redemption presentation metadata on both owned-voucher
response paths:

- `GET /api/v1/my-redemption-items` → each `items[]` entry
- `POST /api/v1/redemptions/{redemptionItemId}/redeem` → returned `item`

Requested JSON fields: `typeItems`, `isLink`, `isBarcode`, `isQr`, `isText`,
`timeLimit`, and `codeName`.

## Type

feature

## Workstream

backend

## Priority

medium

## Goal

Expose the seven requested fields additively on the shared
`UserRedemptionItem` contract used by both endpoints. Values must come from the
current `redemption_items` row configured by Backoffice, so Mobile can render
the redeemed value without joining the browse catalog.

## Contract semantics

| JSON field | Proto field | Source | Default / legacy behavior |
|---|---|---|---|
| `typeItems` | `type_items` | `redemption_items.type_items` | empty string when absent |
| `isLink` | `is_link` | `redemption_items.is_link` | `false` means Code, including legacy rows |
| `isBarcode` | `is_barcode` | `redemption_items.is_barcode` | `false` |
| `isQr` | `is_qr` | `redemption_items.is_qr` | `false` |
| `isText` | `is_text` | `redemption_items.is_text` | `false` only when configured false |
| `timeLimit` | `time_limit` | `redemption_items.time_limit` | empty string when absent |
| `codeName` | `code_name` | `redemption_items.code_name` | empty for legacy rows; do not fabricate |

These are **live item configuration values**, not snapshots captured into
`user_redemption_items` at redemption time. A later Backoffice edit therefore
changes what both endpoints return. Historical snapshotting is explicitly out
of scope and would require a separate schema/write-path decision.

## Scope

| Service | Why |
|---|---|
| `shared-lib` | Extend `orderpb.UserRedemptionItem` additively and regenerate protobuf/grpc-gateway artifacts |
| `Games-Labs-Order` | Load the seven current item values, carry them in the domain model, and map them on list, fresh redeem, and idempotent replay paths |
| `api-gateway` | Consume the published shared-lib version and prove the REST camelCase wire shape, including explicit false booleans |

### Expected files

- `shared-lib/proto/orderpb/order.proto`
- generated `shared-lib/proto/orderpb/order*.go` / gateway artifacts produced by the repository's normal proto generation command
- `shared-lib/proto/orderpb/order_contract_test.go`
- `Games-Labs-Order/internal/models/redemption.go`
- `Games-Labs-Order/internal/core/repositories/redemption.go`
- focused Order repository/handler tests under `Games-Labs-Order/internal/core/**`
- `Games-Labs-Order/go.mod` and `Games-Labs-Order/go.sum`
- `api-gateway/go.mod` and `api-gateway/go.sum`
- `api-gateway/gateway/order_redemption_routes_test.go`

Out of scope: new endpoints, request-body changes, database migrations,
historical snapshots, Backoffice UI changes, Mobile/Android edits, email
behavior, voucher-code/link canonicalization, production runtime startup, and
unrelated redemption refactors.

`Games-Lab-Android/` remains read-only. It may be inspected to confirm the
consumer shape, but this task must not write there.

## Current source evidence

- `shared-lib/proto/orderpb/order.proto` already exposes all seven fields on
  catalog `RedemptionItem`, but `UserRedemptionItem` ends at field 23 and does
  not expose them.
- Both requested endpoints return `UserRedemptionItem` and pass through
  `modelUserRedemptionItemToPB[At]` in
  `Games-Labs-Order/internal/core/handlers/orderhdl/grpc.go`.
- `Games-Labs-Order/internal/core/repositories/redemption.go` already joins
  `redemption_items ri` for owned rows, but its selected columns omit the seven
  requested values.
- A fresh redeem builds the returned model from the locked
  `RedemptionItem`; an idempotent replay reloads through the joined owned-item
  query. Both paths must be covered.
- `api-gateway/gateway/grpc.go` uses protojson `EmitUnpopulated: true`, so
  false boolean fields can be asserted as present on the REST response.

## Acceptance criteria

1. `orderpb.UserRedemptionItem` adds these backward-compatible fields without
   renumbering or changing fields 1–23:
   - `string type_items = 24`
   - `bool is_link = 25`
   - `bool is_barcode = 26`
   - `bool is_qr = 27`
   - `bool is_text = 28`
   - `string time_limit = 29`
   - `string code_name = 30`
2. Generated protobuf and grpc-gateway artifacts are regenerated from the
   proto; no generated file is edited by hand.
3. Every `GET /api/v1/my-redemption-items` `items[]` entry returns the seven
   fields from the current joined `redemption_items` row.
4. A successful fresh `POST .../redeem` returns the same seven values on
   `item`, populated from the locked item used for the redemption.
5. An idempotent replay of the same redeem returns the same response shape via
   the joined result loader; it must not lose these fields.
6. Legacy blank `code_name` remains `codeName: ""`; legacy/non-Link rows return
   `isLink: false`. The service must not invent historical values.
7. Gateway JSON uses exactly `typeItems`, `isLink`, `isBarcode`, `isQr`,
   `isText`, `timeLimit`, and `codeName`. With the production marshaler,
   boolean keys remain present when false.
8. No schema migration, new route, request change, or new dependency is added.
9. `shared-lib` is published first. Order and gateway then pin the exact
   published pseudo-version, run `go mod tidy`, commit `go.mod` and `go.sum`
   together, and contain no local `replace` directive.
10. Focused shared-lib contract tests, Order mapping/repository tests, and
    gateway REST wire-format tests pass. Each consumer also passes
    `GOWORK=off go build -mod=readonly ./...` with a clean module cache check
    appropriate for the published private module.
11. After Order and gateway reach staging, authenticated smoke verifies both
    endpoints against a controlled staging redemption item whose Backoffice
    values exercise true and false booleans. The POST smoke must use an
    approved test user/item and a unique idempotency key; it must not run
    against production or spend a real user's balance.

## Ordered plan

1. **Shared contract — `shared-lib` (`main`)**
   - Add fields 24–30 to `UserRedemptionItem`.
   - Regenerate artifacts and add descriptor/JSON contract tests.
   - Open/merge the shared-lib PR to `main` and publish the exact pseudo-version.
   - Stop here until the published version resolves from a clean module cache.
2. **Order implementation — `Games-Labs-Order` (`staging`)**
   - Pin the published shared-lib pseudo-version.
   - Extend `models.UserRedemptionItem`.
   - Extend the joined select/scan path with `ri.type_items`, `ri.is_link`,
     `ri.is_barcode`, `ri.is_qr`, `ri.is_text`, `ri.time_limit`, and
     `ri.code_name`.
   - Populate the fresh redeem result from the locked catalog item.
   - Map all fields in `modelUserRedemptionItemToPBAt` and add focused tests for
     list, fresh redeem, and replay behavior.
3. **Gateway contract consumption — `api-gateway` (`staging`)**
   - Pin the same published shared-lib version.
   - Extend the existing redemption route test to assert exact camelCase keys
     and false boolean emission through the production marshaler.
4. **Verification and rollout**
   - Run focused tests plus readonly builds and module-resolution checks.
   - Merge/deploy consumers to staging in dependency order.
   - Perform authenticated GET and controlled POST staging smoke.
   - Keep production parked; no prod ECS/RDS startup is authorized by this task.

## Risks and mitigations

- **Consumer work starts before the contract is publishable.** Stop after the
  shared-lib PR until the exact pseudo-version resolves from a clean cache.
- **Fresh redeem and replay diverge.** Test both paths; fresh results are built
  manually while replay/list results use joined SQL.
- **SQL scan order drifts.** Update select columns and `Scan` arguments in one
  focused change with a repository test.
- **False fields disappear on REST.** Use the gateway's production marshaler in
  the route test and assert key presence, not only decoded values.
- **Live configuration is mistaken for a redemption-time snapshot.** Preserve
  the explicit live-value contract above; snapshotting requires a separate
  approved task.
- **Staging smoke creates a real redemption side effect.** Use controlled test
  data, a unique idempotency key, and record the test item/user in evidence
  without exposing credentials.

## Verification evidence required

- shared-lib proto generation diff and contract test output
- clean-cache shared-lib resolution and exact pseudo-version
- Order focused test output and readonly build
- gateway route test output and readonly build
- verified PR targets (`shared-lib` → `main`; Order/gateway → `staging`)
- authenticated staging GET/POST response evidence with secrets and redeemable
  code/link values redacted
- explicit statement that production runtime was not started


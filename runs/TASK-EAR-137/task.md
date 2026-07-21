# TASK-EAR-137: Player Detail — admin Purchase history (Order service)

## Type

feature

## Workstream

backend

## Priority

medium

## Created

2026-07-18

## Goal

First slice of the Detail-page backend epic (History Transaction /
Game tabs remain mock — see TASK-EAR-134). Wire the **Purchase → Package**
sub-tab on `admin/manage/player/Detail/[id].vue` to real order data from
Games-Labs-Order. Per operator decision (2026-07-18): start with Purchase
only; Game tab (no data source anywhere) and the IDOR bug found in
`ListOrders`/`ListMyRedemptionItems` (public routes trust an unverified
`user_id` param) are explicitly deferred, not in scope here.

## Recon summary (multi-agent, 2026-07-18)

- `orders` table + `OrderRepo.List(ctx, userID, status)` exist and return
  clean fields, but **no pagination** (no LIMIT/OFFSET/COUNT) and **no
  admin RPC** — only the public, unauthenticated-by-ownership
  `OrderService.ListOrders` (`orderhdl/grpc.go:158`) exists.
- `orderpb.Order` (the wire message) already carries everything the
  Purchase→Package table needs **except a payment-method field** — no such
  field exists anywhere in the Order schema (only `PaymentReference`, a
  gateway transaction ref, not a method label). Show `-` for that column
  (established no-fabrication pattern from TASK-EAR-134), don't invent one.
- No `name`/`item` field either — closest existing field is `description`
  (free text) or the `OrderType` enum
  (`TOPUP_CRYSTAL | EXCHANGE_COIN | BUY_ITEM | REWARD_CLAIM`). Use
  description when present, else a label derived from `type`.
- `HISTORY_SUB_TABS.Purchase = ['Package', 'Special Pass', 'Limited Avatar']`
  — Order's `type` enum doesn't cleanly split into those three product
  categories without further mapping. **Only 'Package' is wired here**;
  'Special Pass' and 'Limited Avatar' stay on the design placeholder.
- Existing `modelOrderToPB` (orderhdl package) is reusable in spirit but is
  package-private — mirror it locally in adminorderhdl (same pattern as
  TASK-EAR-133's `adminUserRedemptionItemToPB`), don't cross-import.
- `ListRedemptionItems`/`CountRedemptionItems` (redemption.go) already show
  the LIMIT/OFFSET + COUNT pattern to mirror for a new paginated Order
  query.

## Scope

In:
- Games-Labs-Order: new repo method (e.g. `ListOrdersPaginated`) —
  **additive**, does NOT change the existing `List` used by the public
  `ListOrders` RPC (minimal-change: no risk to public API behavior).
  LIMIT/OFFSET + COUNT, ordered `created_at DESC`, filtered by `user_id`.
  New service method `ListOrdersForUser`. New adminorderhdl gRPC handler,
  staff-gated `PERM_ORDER_MANAGEMENT`.
- shared-lib (`adminorderpb`): new RPC `ListOrdersForUser` —
  `GET /api/v1/admin/orders/user/{user_id}` — request `{user_id, page}`,
  response `{status, orders: []orderpb.Order, page}` (reuses the existing
  `orderpb.Order` message — no new item message needed).
- api-gateway: bump.
- Games-Labs-backoffice: `Detail/[id].vue` — **data-source-only change,
  same as TASK-EAR-134** (see [[preserve-ux-design-wire-data-only]]). Wire
  ONLY the Purchase→Package sub-tab's rows from the new admin RPC; leave
  the Purchase→Special Pass / Limited Avatar sub-tabs and every other
  History main-tab (Earned/Redeem/Send coin) on the existing design
  placeholder. No template changes.

Out: Game tab (no data source — operator deferred), the `ListOrders`/
`ListMyRedemptionItems` IDOR (operator deferred, separate concern),
Earned/Redeem/Send-coin wallet-transaction wiring (separate, larger slice
— wallet_transactions has no read API at all, needs its own categorization
design), Special Pass / Limited Avatar purchase sub-tabs (Order's type
enum doesn't map to these categories cleanly).

## Acceptance criteria

- `GET /api/v1/admin/orders/user/{user_id}?page.size=&page.offset=`
  returns a real player's orders, paginated, staff-gated.
- Existing public `GET /api/v1/orders` behavior/signature unchanged (new
  repo method is additive, not a modification).
- Detail page Purchase→Package sub-tab shows real order rows for a real
  player id; Payment methods column shows `-` (not fabricated); Name shows
  description or a type-derived label; other sub-tabs/tabs unchanged
  (still placeholder). No template/design changes elsewhere.
- `go build`/`go test` green in Order; backoffice `npm run build` green;
  PRs opened (Order+gateway → staging, FE → main).

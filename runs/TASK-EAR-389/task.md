# TASK-EAR-389 — Per-player promotion history for the monitoring report

Parent: TASK-EAR-291. Owner: Games-Labs-Order.

## Problem

The player report Promotion tab says promotion history is not available. The
History tab already shows purchases, points, and coin transfers. It is not
this tab. The promotion drill-down is keyed by coupon, not by player.

## Outcome

The Promotion tab lists that player's promotion uses from Order. An empty
history is an empty table, not the unavailable message.

## Scope

- `Games-Labs-Order` owns the per-user read. Reuse stored coupon usage before
  adding a table.
- `shared-lib` holds a new RPC if none exists. Publish before the consumer bump.
- `api-gateway` follows the module bump.
- `Games-Labs-backoffice` binds the Promotion tab on
  `app/pages/admin/monitoring/report/player/[id].vue`.

## Acceptance

- The tab shows that player's promotion uses, with the coupon identity Order stores.
- The unavailable copy on the Promotion tab is gone.
- An authenticated admin-dev read of one player with a known coupon use matches Order.

## Implementation plan (Claude lane, 2026-10-12)

Read-only investigation of the deployed branches (Order/gateway `staging`,
shared-lib/backoffice `main`). Key facts were re-checked by hand.

**Source of truth: Order `coupon_usages`** (`migrations/028_add_transactional_coupon_usage.sql:19-38`,
`029:37`): coupon id/type/code, user_id, order_id, status
(reserved|consumed|released|refunded), granted discount minor units + currency,
reserved/consumed/released/refunded timestamps, complimentary reward snapshot.
Coupon names and offer settings join from `complimentary_coupons` /
`discount_coupons` (TEXT ids, so `cu.coupon_id::text`). No index leads with
`user_id` (checked: 028:40-46, 029:39), and no RPC lists coupon usage.
The Logs promotion drill-down is keyed by code and only sees settled
purchases inside a 12-month window, so Order stays the owner as scoped.

**Change order**

1. shared-lib: `AdminOrderService.ListCouponUsagesForUser`,
   `GET /api/v1/admin/orders/user/{user_id}/coupon-usages`. Request: user_id=1,
   basepb.Pagination page=2, coupon_type=3 (unset = both), repeated
   statuses=4, search=5, from=6, to=7. Item `AdminCouponUsage`: orderpb.CouponUsage
   usage=1 plus catalog display fields (coupon_name, percentage/max discount,
   coin/diamond/point amounts, pass/avatar names). Response: status=1, items=2,
   page=3. No collision with `/orders/user/{user_id}` (6 vs 5 segments). Do NOT
   use `/admin/promotion-coupons/usages`; it collides with
   `/promotion-coupons/{id}` (last-registered pattern wins). Publish first.
2. Order: bump shared-lib (from bf1fcf4), migration 046
   `CREATE INDEX IF NOT EXISTS idx_coupon_usages_user_created ON coupon_usages(user_id, created_at DESC);`
   (no CONCURRENTLY: the boot runner execs each file as one statement batch;
   embed + Exec after `migrations/run.go:279`), repository list with LEFT JOINs
   to the coupon tables and `special_items`, handler gated on
   PERM_ORDER_MANAGEMENT.
3. api-gateway: shared-lib bump only (AdminOrder already registered at
   `gateway/grpc.go:156`) plus a route test.
4. backoffice: `PlayerReportPromotionTab.vue` already exists with mock rows
   ("(Mock)" at :143). Wire real data into that designed component; do not
   redesign it. New composable modelled on `useAdminPlayerPurchaseHistory.ts`.
   Remove the unavailable copy at `report/player/[id].vue:98-104`.

**RED tests**

- shared-lib: gateway binding of `user_id` on the new path; field numbers.
- Order (real Postgres): two users seeded, only the target's rows, newest
  first, correct total, empty list for a user with none, refunded included and
  released excluded by default; handler 1002 on a bad uuid and non-staff
  rejection; index present after two boot replays.
- gateway: the new path reaches the new RPC while `/orders/user/U` still
  reaches `ListOrdersForUser`.
- backoffice: flip `tests/playerReportUnavailableStates.test.mjs:17,34` (copy
  gone, tab component used), no "(Mock)", empty response renders an empty table.

**Open questions for the operator**

1. Which statuses show by default: consumed + refunded only, or also
   reserved/released?
2. Value column: the discount actually granted, or the catalog percentage?
3. Permission: PERM_ORDER_MANAGEMENT or a monitoring permission?
4. Search and date range on the server or the client?

Risks: names/percentages come from the current catalog (edited or deleted
coupons show "-"); expired-but-unreleased `reserved` rows.

## Operator decisions (2026-10-12) — contract can be frozen

1. **Default statuses:** `consumed` + `refunded`. `reserved` and `released` are
   excluded by default; the `statuses` request field may still ask for them.
2. **Value column (Discount Code):** the discount actually granted, from
   `coupon_usages.discount_amount_minor_units` / `discount_currency`, which does
   not change when the coupon is later edited. Catalog percentage and max
   discount may be returned as supplementary display fields.
3. **Permission:** `PERM_ORDER_MANAGEMENT`, same as `ListOrdersForUser`.
4. **Search and date range:** server-side (`search`, `from`, `to` in the
   request), so `total` and paging stay correct.

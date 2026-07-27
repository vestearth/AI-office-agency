# TASK-EAR-158 — Wire Purchase → Special Pass / Limited Avatar history on Player Detail page

## Context

From TASK-EAR-137 (Package purchase history wiring, merged) and the
2026-07-27 Player Detail page audit (see knowledge-base memory
`detail-page-backend-epic`): the History Transaction → Purchase tab on
`admin/manage/player/Detail/[id].vue` has 3 sub-tabs — **Package** (wired),
**Special Pass**, and **Limited Avatar** (both still mock, `mock.ts`).

Order's `type` enum already includes `BUY_ITEM`, which is a candidate for
Special Pass / Limited Avatar purchases — this needs verifying before any
backend work is scoped, since it may already carry enough data to reuse the
existing `ListOrdersForUser` RPC (`shared-lib/proto/admin/adminorderpb`,
implemented in `Games-Labs-Order/internal/core/services/ordersvc/service.go`)
with no new endpoint.

## Objective

Wire Purchase → Special Pass and Purchase → Limited Avatar sub-tabs to real
Order data, reusing `ListOrdersForUser` if the data already distinguishes
item type — building only the minimum backend surface actually missing.

## Investigation required first (before any FE change)

1. Check how Special Pass and Limited Avatar purchases are actually created
   on the Order side today — are they `BUY_ITEM` orders? What does the
   `BUY_ITEM` payload/metadata carry (item type, item name, catalog id)?
2. If `BUY_ITEM` rows already carry a field that distinguishes "Special
   Pass" vs "Limited Avatar" vs other item purchases, no new backend RPC is
   needed — only FE composable work (same pattern as
   `useAdminPlayerPurchaseHistory.ts` used for Package).
3. If item-type is not cleanly distinguishable from current Order data,
   stop before implementing — write up exactly what's missing (e.g. a
   catalog join, an `item_type` column) as a follow-up scope, not a
   workaround.

## Scope

- `Games-Labs-Order` — read-only investigation; only touch code if a small,
  additive field/mapping change (not a new endpoint) turns out to be needed.
- `Games-Labs-backoffice` — `useAdminPlayerPurchaseHistory.ts` (or a new
  sibling composable) and the Purchase sub-tab wiring in
  `app/pages/admin/manage/player/Detail/[id].vue`.

## Acceptance criteria

- Special Pass and Limited Avatar sub-tabs render real per-player order rows
  instead of `mock.ts` data, following the same UX/table structure already
  approved for Package (no redesign — see `preserve-ux-design-wire-data-only`
  memory).
- If `BUY_ITEM` reuse is confirmed viable: no new backend PR, FE-only change,
  and the investigation evidence (file:line) is recorded in `dev-output.yaml`.
- If reuse is not viable: task closes with a concrete, evidence-based
  follow-up scope for the missing backend piece — not a speculative fix.

## Out of scope

- Game tab (no backing data anywhere — separate, larger epic).
- Earned/Redeem/Send-coin tabs and Summary sidebar coin totals (needs a new
  wallet-ledger read API — separate task).
- Contact (Facebook/Line/Address) and Device Info (IP/Serial) mock fields —
  no schema exists yet, separate product decision.
- The known IDOR in Order's `ListOrders` / `ListMyRedemptionItems`
  (`orderhdl/grpc.go`) — flagged, deliberately not part of this task, do not
  fix opportunistically without a dedicated task since it's a security-review
  scoped change.

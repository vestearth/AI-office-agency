# TASK-EAR-209: Redemption item "Available" codes — real Redeem Date / User Name

## Type

bugfix

## Workstream

backend

## Priority

medium

## Created

2026-08-04

## Goal

The Backoffice redemption-item detail page (Code tab → Available sub-tab)
hardcodes `Redeem Date` and `User Name` to `'-'` for every row
(`app/pages/admin/manage/redemption/items/edit/[id].vue:844-849`, function
`loadAvailableItemCodes`). `Code` is real (from
`GET /api/v1/admin/redemption-items/{id}/codes`); the other two columns were
never backed because the endpoint only reads `redemption_item_codes` (no
claim data). The claim data (`user_id`, `redeemed_at`) lives in
`user_redemption_items`, joined via `redemption_code_id` — confirmed by
reading `Games-Labs-Order/internal/core/repositories/redemption.go` and
migration `023_create_user_redemption_items.sql`.

## Recon (2026-08-04)

- No repository method today lists `user_redemption_items` by
  `redemption_item_id` (only by `user_id`, for the player's own history).
  The fix is a LEFT JOIN from `redemption_item_codes` (existing source of
  `ListRedemptionItemCodes`) to `user_redemption_items` on
  `redemption_code_id` — unclaimed codes keep NULL user/redeemed_at.
- Username resolution: grepped for a "resolve raw user_id → display name"
  precedent anywhere in the admin surface. Found **none** — Wallet's coin/point
  history composables hit the exact same gap and deliberately show `'-'`
  (`useAdminPlayerSendCoinHistory.ts:70-75`, explicit comment: "no
  display-name field exists... honest '-' rather than a fabricated value").
  The only real lookup available is `adminuserpb.GetUser` →
  `GET /api/v1/admin/user/{user_id}` (single id, no batch RPC in either
  `userpb` or `adminuserpb`), already used by the frontend today
  (`useAdminVipLevel.ts:24-37`, `fetchPlayerVip`). No backend service calls
  User via gRPC for admin-display purposes anywhere (Wallet/Missions/
  Provider/Game all call `userpb.GetProfile` server-side, but only for a
  single already-known user_id inside business logic, never to bulk-resolve
  a list for display) — Order adding its own gRPC client to User purely for
  this would be a new cross-service dependency for a display-only concern.
  **Decision:** keep `Order` proto/backend scope to `user_id` +
  `redeemed_at` only; resolve the display name client-side in the
  Backoffice, per-unique-id on the current page (≤10 rows/page today),
  mirroring `fetchPlayerVip`'s existing call shape. Falls back to the raw
  `user_id` (not a fabricated name) if `GetUser` errors, consistent with
  the Wallet precedent.
- Also found: the adjacent **"Redeemed" sub-tab is a separate, bigger stub**
  — its column headers already exist
  (`edit/[id].vue:2024-2029`) but `itemCodeSourceRows` returns `[]`
  unconditionally for it (`:787`); it has no fetch function at all, and
  (unlike Available) would need to cover `gift`-type items too, which have
  no code row at all (`user_redemption_items` only). **Out of scope here**
  — flagged separately, do not silently fold it into this task.

## Scope

In:
- `shared-lib` `orderpb.RedemptionItemCode`: add `string user_id = 6` and
  `google.protobuf.Timestamp redeemed_at = 7` (both unset for an unclaimed
  code). `ListRedemptionItemCodesResponse` already embeds this message
  directly, so no other proto changes are needed.
- `Games-Labs-Order`:
  - `internal/models/redemption.go`: `RedemptionItemCode` gains
    `UserID string`, `RedeemedAt *time.Time`.
  - `internal/core/repositories/redemption.go`:
    `ListRedemptionItemCodes` LEFT JOINs `user_redemption_items` on
    `redemption_code_id` and selects `user_id`/`redeemed_at`.
  - `internal/core/handlers/adminorderhdl/adminorderhdl.go`:
    `modelRedemptionItemCodeToPB` maps the two new fields
    (nil-safe timestamp).
  - No migration — both source columns already exist (migration 023).
- `Games-Labs-backoffice`:
  - `RedemptionItemCodeApi` type gains `userId?`, `redeemedAt?`.
  - `loadAvailableItemCodes()`: map `redeemDate` via the existing
    `isoToDmy()` helper; resolve `userName` by calling
    `GET /api/v1/admin/user/{userId}` once per distinct claimed `userId` on
    the page (parallel, deduped), falling back to the raw id on error/miss;
    both stay `'-'` when the code is unclaimed.
- Regression test: Go integration test in
  `Games-Labs-Order/tests/integration` — seed an e-voucher item + code,
  assert `ListRedemptionItemCodes` returns empty `UserID`/nil `RedeemedAt`
  before redeem and the real values after.

Out:
- The "Redeemed" sub-tab stub (separate follow-up — needs its own
  list-by-item query covering gift-type items with no code row).
- Any batch/bulk user-lookup RPC (none exists today; per-id calls are
  acceptable at current page sizes).

## Acceptance criteria

- `GET /api/v1/admin/redemption-items/{id}/codes` returns `userId` +
  `redeemedAt` for a claimed code, both empty/unset for an unclaimed one.
- Backoffice Available tab shows a real formatted redeem date and a
  resolved (or honestly-raw-id) user name instead of `'-'` for claimed
  codes; unclaimed codes still show `'-'`.
- `go build ./...` and the new integration test pass locally
  (`ORDER_TEST_DATABASE_URL` against a local throwaway Postgres db).
- Existing `TestRedeemEnforcement_*` tests unaffected.

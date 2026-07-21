# TASK-EAR-133: Send E-Voucher — admin grant of a redemption item (free, quota-enforced)

## Type

feature

## Workstream

backend

## Priority

high

## Created

2026-07-17

## Goal

Make the player-editor "Send E-Voucher" panel real. It currently imports
`~/data/mock` and shows "E-Voucher sent successfully." without any request —
admin believes a voucher was given when nothing happened. Backend model:
"sending" an e-voucher = **granting a redemption item (type=`e-voucher`) into
the player's in-app account**, via a flow identical to
`RedeemRedemptionItem` minus the point debit. The voucher lands in the
player's `ListMyRedemptionItems` inventory with a real code consumed from
stock.

Order owns redemption items + codes + quota. The quota/stock enforcement
(TASK-EAR-087: one-time / daily-player / daily-item / total_quota + code
stock) lives in the repo FOR UPDATE tx, independent of the wallet debit
(which is in the service) — so a free grant reuses the same enforcement.

## Operator decisions (2026-07-17)

1. **Send channel**: keep the App/Email/SMS "Send via" UI as-is for now
   (display-only); the grant always lands in the in-app account. Real
   email/SMS voucher delivery is a future task — no backend mechanism today.
2. **Actor audit**: add a migration — `user_redemption_items` gets
   `granted_by TEXT NOT NULL DEFAULT ''` and `source TEXT NOT NULL DEFAULT
   'player'`. Admin grants record `source='admin_grant'` + `granted_by` =
   staff id; normal redeems keep `source='player'`, `granted_by=''`.
3. **Date window**: admin grant enforces `active` only — it **skips** the
   not-started / expired window (a grant is the admin's deliberate act).
   Quota + code stock are still enforced.

## Scope

In:
- shared-lib (`adminorderpb`, already imports `orderpb`): RPC
  `GrantRedemptionItem` — `POST /api/v1/admin/redemptions/{redemption_item_id}/grant`,
  body `{user_id, idempotency_key}`; response `{status,
  orderpb.UserRedemptionItem}`.
- Games-Labs-Order:
  - Migration 030: add `granted_by` + `source` to `user_redemption_items`
    (defaults keep the existing redeem INSERT valid).
  - Repo: extract the current `RedeemRedemptionItem` tx body into a private
    `redeemTx(..., source, grantedBy string, pointSpent int64)` so ALL quota
    enforcement stays in one place; existing `RedeemRedemptionItem` calls it
    with `("player", "", item.Point)`; new `GrantRedemptionItem` calls it
    with `("admin_grant", grantedBy, 0)`. The INSERT writes the two new
    columns.
  - Service `GrantRedemptionItem(ctx, req)`: validate user_id +
    redemption_item_id (uuid), load item, require it exists + `Status`
    (active) — SKIP the date-window checks, no wallet call; generate an
    idempotency key if the caller left it empty.
  - Handler (`adminorderhdl`): gRPC `GrantRedemptionItem`,
    `RequireStaffMetadata(PERM_ORDER_MANAGEMENT)` → `grantedBy = td.UserId`.
- api-gateway: shared-lib bump.
- Games-Labs-backoffice `SendVoucherPanel.vue`: left list from admin
  `ListRedemptionItems` filtered to `type=e-voucher`; Send loops the
  selected items → `POST .../grant {user_id}` (per-item failure reporting,
  toast only on real result); remove mock import; keep the "Send via" UI
  display-only.

Out:
- Real email/SMS voucher delivery (future).
- Gift-type grant UX (RedeemRedemptionItem already handles gift = no code;
  the panel is e-voucher only).
- Detail page (TASK-EAR-134).

## Acceptance criteria

- `POST /api/v1/admin/redemptions/{id}/grant {user_id}` creates a
  `user_redemption_items` row with `source='admin_grant'`,
  `granted_by`=staff id, `point_spent=0`, a code consumed from stock, and
  `quota_used/total_redeemed` incremented; it appears in the player's
  `ListMyRedemptionItems`.
- Quota conditions reject over-limit grants exactly like redeem (one-time /
  daily-player / daily-item / total / code-exhausted); inactive item
  rejected; expired/not-started item still grantable (date skipped).
- Normal player redeem path unchanged (same enforcement, `source='player'`).
- `go build`/`go test` green in Order (incl. a grant test); backoffice
  `npm run build` green; PRs opened (Order+gateway → staging, FE → main).

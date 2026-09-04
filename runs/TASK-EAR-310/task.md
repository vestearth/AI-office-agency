# TASK-EAR-310 — Redeem > History: redeemedAt, status and date filter on my-redemption-items

## Type

feature

## Workstream

backend

## Priority

medium

## Created

2026-09-03

## Goal

Mobile is building the Redeem > History page and asked (2026-09-03) which
endpoint to use. `GET /api/v1/my-redemption-items` (My Voucher) is the same
data set but the public contract has no `redeemedAt`, no `status`, and no
date filter, so it cannot be reused as-is.

Decision: extend the existing endpoint additively instead of adding a new
one. My Voucher and History are the same `user_redemption_items` rows with
different filters.

## Evidence that drove the scope

- `user_redemption_items` already stores `status` (constant `'redeemed'`,
  never transitioned) and `redeemed_at` (migration 023); the Go model scans
  both; `modelUserRedemptionItemToPB` drops them.
- `ListMyRedemptionItemsRequest` is `user_id, limit, offset` only; repo
  `WHERE user_id = $1` only.
- Knowledge base (Field Lineage — Store Packages & Redemption, TASK-EAR-216
  note) recorded "exposing server status is still deferred".

## Field semantics (locked)

| JSON | Proto | Source / rule |
| --- | --- | --- |
| `redeemedAt` | `redeemed_at = 18` (Timestamp) | `user_redemption_items.redeemed_at` |
| `status` | `status = 19` (string) | Derived at read time: `expired` when `validUntil` is set and before now, else `active`. NOT the stored column (always `redeemed`). The backend does not track voucher usage, so `used` is not a value. |
| `fromDate` (query) | `from_date = 4` (string) | `YYYY-MM-DD`, inclusive, Asia/Bangkok day start, applied to `redeemed_at` |
| `toDate` (query) | `to_date = 5` (string) | `YYYY-MM-DD`, inclusive, Asia/Bangkok day end, applied to `redeemed_at` |

Invalid date string → `invalid request` status (no transport error).
Both filters optional; omitted = unchanged behaviour. `total` in pagination
respects the same filter.

## Out of scope (await Mobile)

- A `used` state / mark-as-used endpoint — product decision pending.
- A `status` request filter — not requested.

## Gates (same shape as TASK-EAR-216/220)

1. shared-lib: additive fields; `make buf`; PR to main; stop for publish
2. Games-Labs-Order: bump; handler date parse + repo WHERE + mapper; tests RED→GREEN; PR `--base staging`
3. api-gateway: same shared-lib bump on `staging` (gateway owns the wire format)
4. Staging deploy; prove via raw response body through the gateway; Mobile handoff

## Acceptance criteria

- [x] `UserRedemptionItem` has additive `redeemed_at = 18`, `status = 19`
- [x] `ListMyRedemptionItemsRequest` has additive `from_date = 4`, `to_date = 5`
- [x] `GET /api/v1/my-redemption-items` returns `redeemedAt` + `status` through the gateway
- [x] `?fromDate=&toDate=` narrows both items and `page.total`; bad date → invalid request
- [x] Redeem response `item` carries the same fields
- [x] No committed `replace`; `-mod=readonly` build passes after bump
- [x] Existing fields unchanged

## Assignment

- Primary: `dev`
- Parallel: false

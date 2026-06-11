# TASK-090: Wire `type_items` + read `total_quota` (partial B6 — contract already present)

## Short name
`redemption-type-items-wiring`

## Type
feature

## Priority
high

## Parent / Epic
- Parent: `TASK-080`
- Epic: Admin Redemption Management

## Status

In progress. Backend partially closed gap **B6**: the proto/DB now have
`type_items` (string, `"e-voucher"` | `"gift"`) and `total_quota`. Verified in
source:

- `CreateRedemptionItemRequest.type_items` (adminorder.proto:389, field 23),
  `UpdateRedemptionItemRequest.type_items` (adminorder.proto:445, field 24).
- `RedemptionItem` response has `type_items` (order.proto:162), `quota_used` (163),
  `total_quota` (164), `total_redeemed` (165).
- Constants: `RedemptionItemTypeEVoucher = "e-voucher"`,
  `RedemptionItemTypeGift = "gift"` (Games-Labs-Order models/redemption.go:12-13).
- Service normalize: `type_items` defaults to `"e-voucher"` when blank; must be one
  of the two; **E-Voucher requires `code`**; **`point` must be > 0**
  (ordersvc/service.go:939-1004).
- `total_quota` is NOT in the create/update request — backend derives it:
  Gift → 0, E-Voucher → code count (redemption.go:34-52).

Per the user: wire ONLY what the current contract supports — send/consume
`type_items` and read `total_quota` from the response so tabs/edit stop hardcoding.
Do NOT add manual Gift `total_quota` to the request (waits for backend).

## Scope

### Affected files (frontend only)

| Path | Action | Description |
| --- | --- | --- |
| `app/components/RedemptionItemCreateModal.vue` | modify | Send `type_items` ("e-voucher"/"gift") by kind. |
| `app/pages/admin/manage/redemption/items.vue` | modify | Read `typeItems`→typeLabel (drives the E-Voucher/Gift tab filter) + `totalQuota`. |
| `app/pages/admin/manage/redemption/items/edit/[id].vue` | modify | Read `typeItems`/`totalQuota` (un-hardcode B6); send `typeItems`; restrict TYPE_OPTIONS to the 2 valid values. |

### Out of scope (still backend-blocked)

- Manual Gift `total_quota` persistence (no request field) — B6 remainder.
- `total_redeemed` → "Total Redeemed" column (B5) — field now exists in the response;
  noted as a future quick win, not wired here.
- Separate "Limit per Player" field (B7).

## Acceptance Criteria

- [ ] Create sends `type_items` so Gift items are persisted as `"gift"` (not defaulted to e-voucher).
- [ ] List reads `typeItems` → E-Voucher/Gift tabs filter for real (no longer "both tabs").
- [ ] Edit reads `typeItems`/`totalQuota` instead of hardcoded ''/0; sends `typeItems` on update.
- [ ] `nuxi typecheck` clean for the 3 files.

## Notes / follow-ups to flag

- Backend requires `point > 0`; FE create currently allows 0 (would 400). Flag — not changed here.
- List type pill is now redundant with the tab filter (design omits it) — left as-is for now.

## Verification

- `cd Games-Labs-backoffice && npx nuxi typecheck`.
- Manual (with real token): create a Gift → reload → it stays under the Gift tab;
  edit shows real Type + Total Quota.

## Assignment

- Primary: `dev`
- Parallel: `false`

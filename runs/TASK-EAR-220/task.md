# TASK-EAR-220: My E-Vouchers — return thumbnailUrl and logoUrl on owned list

## Type

feature

## Workstream

backend

## Priority

medium

## Parent

TASK-EAR-216

## Created

2026-08-06

## Goal

Send Item Basic images on `GET /api/v1/my-redemption-items` so Mobile can
replace the local gift-envelope placeholder with the admin-uploaded item art.

TASK-EAR-216 shipped `itemName`/`brandName` and deferred images. Operator now
wants images included.

## Field semantics (locked)

| JSON | Proto | Source |
| --- | --- | --- |
| `thumbnailUrl` | `thumbnail_url` | `redemption_items.thumbnail_url` (Item Basic) |
| `logoUrl` | `logo_url` | `redemption_items.logo_url` (Item Basic banner) |

Empty string when missing. **Out of scope:** Library brand `thumbnailUrl`
(separate field if Mobile asks later).

## Gates (same as TASK-EAR-216)

1. shared-lib: additive fields 14–15 on `UserRedemptionItem`; `make buf`; stop for publish
2. Games-Labs-Order: bump; extend select/scan/mapper (+ redeem insert path); tests; prefer `--base staging` or main+promotion
3. api-gateway: same shared-lib bump on `staging`
4. Staging deploy + Mobile can wire image URLs

## Acceptance criteria

- [ ] `UserRedemptionItem` has additive `thumbnail_url` and `logo_url`
- [ ] Authenticated `GET /api/v1/my-redemption-items` returns them from Item Basic columns
- [ ] Redeem response `item` carries the same fields
- [ ] No committed `replace`; `-mod=readonly` build passes after publish/bump
- [ ] Existing display-name fields unchanged

## Assignment

- Primary: `dev-2`
- Parallel: false
- Start Gate 1 only

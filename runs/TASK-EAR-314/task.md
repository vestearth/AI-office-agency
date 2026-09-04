# TASK-EAR-314 — Persist Gift shipping address and contact email on redeem

## Type

feature

## Workstream

backend

## Priority

medium

## Created

2026-09-04

## Parent / Epic

- Parent: none
- Epic: Redemption gift/link fulfillment
- Sequence: **1 of 3**. Unblocks TASK-EAR-315 (mailer) and TASK-EAR-316 (send email).

## Goal

Figma Redeem > Gift collects a shipping address and a contact email before
Send. `POST /api/v1/redemptions/{redemption_item_id}/redeem` currently accepts
only `userId` + `idempotencyKey` and stores neither field. Persist a
**per-redemption snapshot** of both values on Gift redeem so Backoffice
Tracking can show Address, and so later email work has a real recipient.

This task does **not** send email.

## Locked decisions (operator 2026-09-04)

- Contact email is the Gift-fulfillment recipient for **this redeem**, not
  `users.email`.
- Store the snapshot on `user_redemption_items`, not on User profile.
- Gift requires both fields. E-Voucher must not persist them.
- No mailer, Link-email, or tracking-number email in this run.

## Evidence that drove the scope

- `RedeemRedemptionItemRequest` is `user_id`, `redemption_item_id`,
  `idempotency_key` only (`shared-lib/proto/orderpb/order.proto`).
- Gift redeem skips code assignment and INSERTs `user_redemption_items`
  without address/email (`Games-Labs-Order/internal/core/repositories/redemption.go`).
- `User` has `email` and no shipping address (`shared-lib/proto/userpb/userpb.proto`).
- Backoffice Tracking Address is hardcoded `—` (TASK-EAR-241 deferred).
- Android Gift Send keeps address/email in local UI and does not POST them
  (`Games-Lab-Android` is **read-only**; mobile wiring is a human handoff).

## Contract (additive)

| JSON | Proto | Rule |
| --- | --- | --- |
| `shippingAddress` | `RedeemRedemptionItemRequest.shipping_address = 4` | Required non-empty for `type_items=gift`. Reject if set on e-voucher. |
| `contactEmail` | `RedeemRedemptionItemRequest.contact_email = 5` | Required valid email for Gift. Reject if set on e-voucher. |
| `shippingAddress` | `UserRedemptionItem.shipping_address = 20` | Copied onto the redeemed row; empty on pre-change rows and admin grants. |
| `contactEmail` | `UserRedemptionItem.contact_email = 21` | Same snapshot. Do not substitute `users.email`. |

Identity remains trusted caller metadata. Body `user_id` stays ignored.

Idempotent replay of the same key returns the original stored snapshot; a
retry with different address/email does not overwrite.

Admin grant stays out of scope (leave both columns empty).

## Gates

1. shared-lib: additive fields; `make buf`; PR to **main**; stop for publish.
2. Games-Labs-Order: bump; migration 039 (next after 038); Gift validation;
   persist/scan/map; tests RED→GREEN; PR `--base staging`.
3. api-gateway: same shared-lib bump on `staging`.
4. Games-Labs-backoffice: Tracking Address (and contact email if the column
   is the redeem snapshot, not account email) from the redeemers payload.
5. Staging proof via gateway JSON; Mobile handoff for Gift Send body.

## Out of scope

- Sending any email (TASK-EAR-315 / TASK-EAR-316).
- User-profile address book.
- Editing `Games-Lab-Android/` (read-only). Record the Mobile body/error
  contract in the handoff only.
- CSV export, Backoffice email-template send.

## Acceptance criteria

- [ ] `RedeemRedemptionItemRequest` has additive `shipping_address = 4` and
      `contact_email = 5`.
- [ ] `UserRedemptionItem` has additive `shipping_address = 20` and
      `contact_email = 21`.
- [ ] Gift redeem without either field returns a stable invalid-request
      business error (not a transport error).
- [ ] Gift redeem with both fields persists them on `user_redemption_items`
      and returns them on the redeem response and owned/redeemers lists.
- [ ] E-Voucher redeem with either field set is rejected; omitted fields
      leave existing e-voucher redeem unchanged.
- [ ] Idempotent replay does not change the stored snapshot.
- [ ] Admin grant does not require or invent address/email.
- [ ] Migration is idempotent and embedded in `migrations/run.go`.
- [ ] No committed `replace`; `GOWORK=off go build -mod=readonly ./...`
      passes in Order and api-gateway after bump.
- [ ] Backoffice Tracking Address renders the persisted shipping address
      (empty/legacy rows stay `—`).
- [ ] Mobile handoff documents the Gift body, validation errors, and that
      Android remains a human lane.

## Assignment

- Primary: `dev-2`
- Parallel: false

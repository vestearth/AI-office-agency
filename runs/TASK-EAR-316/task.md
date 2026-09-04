# TASK-EAR-316 — Send Link e-voucher email and Gift tracking email

## Type

feature

## Workstream

backend

## Priority

medium

## Created

2026-09-04

## Parent / Epic

- Parent: TASK-EAR-314
- Epic: Redemption gift/link fulfillment
- Sequence: **3 of 3**. Blocked on TASK-EAR-314 (Gift contact email snapshot)
  and TASK-EAR-315 (Order mailer).

## Goal

Use the Order mailer to send:

1. **Link e-voucher** — after a successful Link-format redeem, email the
   stored link value to the chosen recipient.
2. **Gift tracking** — when Backoffice first records a non-empty tracking
   number, email that number to the persisted Gift `contact_email`.

Do not invent a second mailer. Do not persist a new shipping-address source
here (that is TASK-EAR-314).

## Locked decisions (operator 2026-09-04)

- Gift tracking mail goes to the **redeem snapshot** `contactEmail`, not
  `users.email`.
- Link-email recipient must be explicit in this task before coding: default
  recommendation is an optional redeem-time `contactEmail` for Link items, or
  `users.email` if product confirms account email. **Stop and ask** if 314's
  Gift-only validation would reject Link contactEmail — extend the contract
  additively if Link needs a recipient field.
- Sending is best-effort after the claim/tracking write succeeds; a mail
  failure must not roll back points or the tracking number. Record a
  distinguishable send status or log field.
- Idempotent: do not send duplicate Link mail on redeem replay; do not
  re-send tracking mail on the same tracking number.

## Evidence that drove the scope

- TASK-EAR-313: `isLink` does not send email.
- TASK-EAR-241: gift-shipment email deferred; no mailer.
- Android Link email-delivery path is a **fixture**, not a live API
  (`Games-Lab-Android` read-only).
- Backoffice Send via Email is display-only.

## Out of scope

- Building the mailer (TASK-EAR-315).
- Shipping-address persistence (TASK-EAR-314).
- SMS.
- Android implementation (human handoff).
- CSV export.

## Acceptance criteria

- [ ] Link-format player redeem can trigger one email containing the stored
      `code`/link to the agreed recipient; replay of the same idempotency key
      does not send a second mail.
- [ ] Gift tracking update sends one email to persisted `contact_email` the
      first time a non-empty tracking number is stored; later identical
      updates do not resend.
- [ ] Gift rows without `contact_email` (legacy / admin grant) skip send
      with a stable, logged reason — they do not fail the tracking write.
- [ ] Mail failure does not undo redeem or tracking persistence; operator
      can see the failure in logs/status.
- [ ] E-Voucher Code format does not send mail.
- [ ] Mobile/Backoffice handoff covers new errors and that Android is human.
- [ ] Focused tests cover send-once, skip-empty-recipient, and mailer-down.
- [ ] No committed `replace`; readonly builds pass.

## Assignment

- Primary: `dev-2`
- Parallel: false
- Blocked on: TASK-EAR-314, TASK-EAR-315

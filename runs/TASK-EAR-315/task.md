# TASK-EAR-315 — Redemption notification mailer (no product emails yet)

## Type

investigation

## Workstream

backend

## Priority

medium

## Created

2026-09-04

## Parent / Epic

- Parent: TASK-EAR-314
- Epic: Redemption gift/link fulfillment
- Sequence: **2 of 3**. Blocked until TASK-EAR-314 Order redeem-contract work is far enough not to collide. Unblocks TASK-EAR-316.

## Goal

Add a **redemption-owned mailer** that later slices can use to send Link
e-voucher mail and Gift tracking mail. This task delivers the send port,
SMTP config, tests, and staging env contract. It does **not** send Link or
Gift emails yet.

## Locked decisions (operator 2026-09-04)

- Order owns redemption notification sends. Do not call Auth OTP or Game
  contact-form mailers.
- Reuse the Auth SMTP pattern (`net/smtp`, fail-loud when host/from unset)
  with **Order-owned** env names and templates.
- Do not invent a new notification microservice in this run.
- Product emails (Link voucher, Gift tracking) wait for TASK-EAR-316.

## Evidence that drove the scope

- TASK-EAR-241 deferred gift-shipment email because there was no email infra
  for that flow.
- Auth SMTP lives in `Games-Labs-Auth/infrastructures/mail_smtp.go`
  (registration/forgot-password OTP).
- Game SMTP is contact-form only (`Games-Labs-Game` `SendContactEmail`).
- Backoffice `SendVoucherPanel.vue` App/Email/SMS is display-only; grants
  land in-app.
- `isLink` classifies values in `code`; it does not send email
  (TASK-EAR-313 / `shared-lib/README.md`).

## Recommended shape (implement after 314, unless operator reopens)

- New Order port, e.g. `Mailer.Send(ctx, to, subject, body)`, with a fake
  in tests.
- Config via `envconfig` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
  `SMTP_PASSWORD`, `SMTP_FROM`) on Order; add names to
  `Games-Labs-Order/ecs/env.names` and the Order staging workflow without
  writing secret values. Follow Auth's existing SMTP env contract, do not
  invent `aws-deploy/ecs/env.names`.
- Missing SMTP returns a stable `email_not_configured` business error on a
  **narrow internal/admin probe or dry-run helper**, not on player redeem.
- Player `POST .../redeem` must not start sending mail in this task.

## Out of scope

- Link e-voucher send and Gift tracking send (TASK-EAR-316).
- Changing Gift redeem request fields (TASK-EAR-314).
- Writing secrets into the repo.
- Android edits.
- Backoffice “Send via Email” becoming a real send (may follow 316).

## Acceptance criteria

- [ ] Order has an injectable mailer port and SMTP adapter; unit tests use a fake.
- [ ] SMTP unset is fail-loud and does not crash process boot; send attempts
      return a stable configured-vs-not status.
- [ ] Order env names for SMTP are declared in the deploy contract; no secret
      values in git.
- [ ] No player redeem, grant, or tracking-update path sends email yet.
- [ ] Auth and Game mailers are unchanged.
- [ ] Focused tests pass; `GOWORK=off go build -mod=readonly ./...` in Order.
- [ ] DevOps handoff lists which staging secrets to map, without values.

## Assignment

- Primary: `dev-2`
- Parallel: false
- Blocked on: TASK-EAR-314

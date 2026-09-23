# TASK-EAR-380 — Send Gift redemption confirmation email after redeem

## Origin

On 2026-09-23 Mobile asked whether the server sends the supplied desktop/mobile
Gift confirmation email after the App's redeem confirmation step. Source review
found that Order sent the Link E-voucher email after redeem, but sent the Gift
email only when Backoffice later entered a tracking number. The existing Gift
email used the subject `Gift Redemption Successful` but contained shipment
details. The operator asked the Backend team to implement the missing
confirmation and then requested this task record.

## Type and ownership

- Type: feature
- Workstream: backend
- Priority: medium
- Owner: `Games-Labs-Order`
- Related: TASK-EAR-314, TASK-EAR-316, TASK-EAR-353 through TASK-EAR-359

## Goal

Send a responsive XPINEXT Gift redemption confirmation to the redeem-time
`contactEmail` after a successful player Gift redeem. This confirms the order
and delivery address before any shipment exists. Preserve the later Backoffice
tracking and tracking-correction emails as separate events.

## Scope and decisions

- Reuse `POST /api/v1/redemptions/{redemption_item_id}/redeem`, which already
  accepts `shippingAddress` and `contactEmail`. No proto, gateway or new public
  API is required.
- Reuse Order's existing multipart text/HTML mailer and responsive redemption
  renderer, including the approved embedded XPINEXT banner.
- Render the redemption ID, Gift name, redeemed date and stored delivery
  address. Do not show tracking number, carrier or shipped date before those
  values exist. The existing User adapter provides `username`, with `Customer`
  fallback; first and last names in the supplied mock are not in this adapter.
- Send after the redeem write commits, without rolling back the redemption on
  mail failure. Record claim, SMTP submission and failure separately; an
  idempotent redeem replay must not send a second accepted message.
- Existing Gift rows and admin grants must not receive a new confirmation
  retrospectively. The additive migration defaults them to ineligible; only
  newly inserted player Gift rows are eligible.
- `Games-Lab-Android/` is read-only. Its current Gift success copy says
  tracking details were already emailed on redeem success; hand that copy
  correction to the Mobile team rather than editing Android here.

## Acceptance criteria

1. A successful new player Gift redeem with a stored recipient submits one
   confirmation email using the updated responsive HTML and plain-text body.
2. The confirmation contains the stored address and no shipment-only fields.
3. Replays and concurrent claims do not submit another accepted confirmation;
   legacy Gift rows and admin grants remain ineligible.
4. SMTP failure leaves redeem success intact, releases the claim when possible,
   and is observable in Order logs. A replay can retry a released claim.
5. Link E-voucher sends, first Gift tracking sends and tracking correction
   sends retain their existing triggers and content.
6. Order tests, readonly build, vet, migration/schema check and diff check pass.
7. Review, staging deployment, a controlled redeem, SMTP submission evidence
   and recipient mailbox receipt are recorded as separate acceptance layers.

## Local implementation checkpoint — 2026-09-23

The Order worktree has an uncommitted implementation in
`internal/core/services/ordersvc/redemption_email.go`, `service.go`,
`internal/core/repositories/redemption.go`, `internal/core/ports/repositories.go`,
focused tests, and `migrations/045_add_gift_confirmation_email_claim.sql`.
`migrations/run.go` embeds the new migration. No shared-lib, gateway or Android
source was changed for this task.

Local verification completed:

- `GOWORK=off go test ./...` passed in `Games-Labs-Order`.
- `GOWORK=off go build -mod=readonly ./...` and `go vet ./...` passed.
- `TestRepositorySQLResolvesAgainstFreshSchema` passed against a disposable
  local PostgreSQL database: 145 statements resolved after fresh migrations.
- The new migration was applied twice on a disposable local database. A
  pre-migration row remained ineligible; a new eligible row could be claimed
  once, while a repeated claim affected no row.
- `git diff --check` passed.

Order commit `3d1eb646df6db4e40df378ab93c8c77e0cd394f2` was pushed on
`task/TASK-EAR-380`; Order PR #77 targets `staging` and is open. Post-commit
evidence `ev-001` through `ev-004` records the tests, readonly build, vet and
fresh PostgreSQL migration/schema check against that exact commit. No staging
deployment, real SMTP submission or mailbox receipt has been verified for this
change.
The migration is additive and forward-only on rollback: an older Order binary
ignores the new columns, which retain any submitted-mail history.

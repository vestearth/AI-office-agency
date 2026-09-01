# TASK-EAR-304: Guarantee Stripe checkout expiry and add optional cancellation

Type: feature. Workstream: backend / payments / shared API contract. Priority: high.

## Goal

Make Stripe package checkout deterministic and safe for Mobile: return a
guaranteed `expiresAt` from checkout creation and provide optional
server-authoritative cancellation. A user may create Package B with a new
`idempotency_id` while Package A remains pending; A continues to expire
naturally if it is not paid or cancelled.

## Locked product decisions

- The guarantee applies only when `provider = stripe`, `type = deposit`, and
  `order_package_id` is present. Other transaction types remain compatible and
  may omit `expiresAt`.
- Repeating the same `idempotency_id` replays the same transaction, Order,
  Checkout Session, cashier URL, and expiry.
- A different `idempotency_id` may create another Stripe package checkout while
  an earlier checkout is pending or processing. Neither checkout is
  automatically cancelled; both remain payable until their own terminal state.
- Creating Package B must never auto-cancel Package A.
- Cancellation is authenticated, ownership-scoped, idempotent, and allowed
  only while the checkout is `pending`.
- Cancellation must expire the Stripe Checkout Session server-side and release
  the bound unpaid Order and coupon reservation through the existing internal
  Order lifecycle. Browser close, Back, or `cancelUrl` navigation is not proof
  of cancellation.
- If processing/payment/fulfillment wins a race, cancellation must not regress
  the transaction or Order; return a stable `CHECKOUT_NOT_CANCELLABLE` result.
- If the atomic Wallet cancel loses to a provider-expiry winner, re-fetch the
  owned transaction. When `payment_status = expired`, `stripe_expired = true`,
  and `order_released != true`, complete `finishStripeCheckoutCancellation`
  idempotently. A successful recovery returns `CHECKOUT_CANCELLED` while the
  transaction snapshot remains `payment_status = expired`; it must not rewrite
  expiry as client cancellation. `CHECKOUT_NOT_CANCELLABLE` remains for paid,
  processing, or fulfillment winners only.
- Android is read-only for all AI agents. This task produces a Mobile contract
  handoff only; it does not authorize Android code changes.

## Committed scope

### Phase 1 — shared-lib contract (hard publication gate)

- Add additive `expires_at` to `CreateTransactionResponse` without renumbering
  or changing existing fields.
- Add an authenticated cancellation RPC and HTTP mapping at
  `POST /api/v1/transactions/{transaction_id}/cancel` with a dedicated response.
- Define a stable structured error for a non-cancellable state; do not require
  Mobile to parse free-text messages.
- Regenerate protobuf, gRPC, grpc-gateway, Swagger, and embedded Swagger files.
- Publish shared-lib before downstream repositories are modified.

### Phase 2 — Games-Labs-Wallet

- Populate create-response `expiresAt` from the exact Stripe Session expiry
  already persisted on `payment_transactions`.
- Preserve same-key replay. A new-key create remains independent of any earlier
  checkout and must not cancel or alter it.
- Add Stripe adapter support to expire a Checkout Session.
- Implement pending-only, ownership-safe, idempotent cancellation and invoke
  existing `FailCheckoutOrder` behavior to release the unpaid Order/reservation.
- Recover a provider-expired winner after an atomic cancel loss by completing
  only the missing Order-release checkpoint; propagate a cleanup/persistence
  failure so a later client retry can resume it.
- Preserve terminal precedence under cancel-versus-webhook races. Paid or
  fulfilled transactions must never move backward.

### Phase 3 — api-gateway and staging acceptance

- Bump the published shared-lib version and keep `go.mod`/`go.sum` together.
- Prove create serialization includes `expiresAt` and cancellation is routed and
  authenticated while the existing create response remains backward compatible.
- Deploy in dependency order to staging and run authenticated acceptance for
  create A, replay A, create B with a new key while A is pending, optional
  cancel, expiry, and cancel/payment race behavior.
- Produce a concise Mobile handoff. Production remains out of scope.

## Explicitly out of scope

- Android source changes.
- Automatic cancellation during create.
- Blocking a new Package B checkout because Package A is pending or processing.
- Changes to non-package deposits or non-Stripe providers beyond preserving
  compatibility.
- Production deployment or production payment testing.

## Acceptance criteria

1. A Stripe package create response always contains a valid server-authoritative
   `expiresAt`; non-package/non-Stripe responses remain backward compatible.
2. Same-key retry returns the same transaction, Order, Stripe Session, cashier
   URL, and expiry without a second reservation or session.
3. A new `idempotency_id` can create Package B while Package A remains pending
   or processing; the new create does not cancel, mutate, or disclose A.
4. An authenticated owner can cancel a pending checkout; repeated cancellation
   returns the same terminal result and does not duplicate cleanup.
5. Unknown and cross-user transaction ids are indistinguishable and disclose no
   checkout data.
6. Processing, paid, or fulfilled checkouts cannot be cancelled. Concurrent
   payment/cancel events preserve the winning terminal state without reward or
   reservation corruption.
7. Successful cancellation expires the Stripe Session and releases the bound
   unpaid Order/coupon reservation; creating Package B never depends on this
   cancellation.
8. If Stripe expiry wins the atomic cancel race, an owner retry completes any
   missing release checkpoint and returns `CHECKOUT_CANCELLED` with
   `paymentStatus = expired`; a paid, processing, or fulfillment winner returns
   `CHECKOUT_NOT_CANCELLABLE`.
9. `cancelUrl`, browser close, and app navigation alone remain non-terminal.
10. Focused tests, full repository tests, readonly builds, generated-contract
   checks, and gateway route tests pass in every changed repository.
11. Authenticated staging proves the full matrix; production is explicitly
    unverified and untouched.

## Dependencies and execution order

1. `shared-lib` contract implementation, review, merge to `main`, and publish.
2. `Games-Labs-Wallet` implementation against the published version.
3. `api-gateway` bump and contract tests against the published version.
4. Ordered staging deploy and authenticated acceptance.
5. Mobile handoff; Android implementation remains a human-owned follow-up.

Downstream implementation must stop at the shared-lib publication gate. Do not
introduce local duplicate contract types or a `replace` directive.

## Verification plan

- `shared-lib`: generated diff review, `GOWORK=off go test ./...`, `go vet ./...`,
  and `GOWORK=off go build -mod=readonly ./...`.
- Wallet: repository/service/handler/Stripe adapter tests including independent
  new-key creates, provider-expired recovery, and cancel-versus-webhook races,
  then full readonly test/build.
- Gateway: route/auth/JSON contract tests, full test/build, and Swagger checks.
- Staging: authenticated create A → replay A → create B with a new key while A
  remains pending → optional cancel A; natural/provider expiry; cross-user denial;
  and a Stripe test-mode race/success
  check with success only on `fulfillmentStatus == "fulfilled"`.
- Run `ruby ai-dev-office/validate-yaml.rb TASK-EAR-304` after every task-state
  change and before handoff.

## Risks

- Stripe expiry can race with a paid webhook. Mitigation: serialize transitions
  and preserve paid/fulfilled terminal precedence.
- Partial deployment can expose new Mobile behavior against old Wallet code.
  Mitigation: shared-lib publication first, Wallet before Gateway acceptance,
  and nullable client parsing during rollout even though the new Stripe package
  contract guarantees the field.

## Closeout note — blocked pending staging runtime diagnosis (2026-08-28)

- Completed and deployed: shared-lib PR #57; Wallet PR #35 and provider-expiry
  follow-up PR #36; api-gateway PR #56. Wallet and Gateway staging workflows
  completed successfully.
- Verified: Wallet focused/full tests and readonly build (`ev-002`–`ev-004`);
  Gateway full test/build; staging gateway health `200`, payment Swagger shows
  cancel and `expiresAt`, and unauthenticated cancellation returns `401`.
- Blocker: fresh authenticated Stripe package-create probes were inconsistent:
  `ev-006`, `ev-008`, and `ev-011` returned HTTP `500`; `ev-007` and `ev-009`
  returned HTTP `200`. DevOps reports all running Wallet tasks use the same
  image, so a mixed-version rollout is not the current explanation.
- Resume only after DevOps correlates the failing requests in
  `/ecs/games-labs-wallet-staging`, verifies runtime task definition/image and
  non-secret Stripe configuration, and a fresh create/replay/new-key/cancel/
  cross-user/expiry acceptance matrix passes consistently. Production remains
  unverified and untouched.

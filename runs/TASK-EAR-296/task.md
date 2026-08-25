# TASK-EAR-296 — Implement the Order checkout lifecycle

## Type / workstream / priority

Feature / backend / high

## Parent / epic

- Parent: TASK-EAR-295
- Epic: Coupon-aware Stripe checkout

## Goal

Implement Order's internal prepare, confirm, and fail RPCs so one durable order
owns the package quote, optional coupon reservation, quota transition, and
reward fulfillment for a Stripe checkout.

## Scope

- Repository: `Games-Labs-Order` only.
- Bump `shared-lib` to `v0.0.0-20260824045720-a2181ce77371`; update `go.mod` and
  `go.sum` together with no `replace` directive.
- Extend the existing Order handler, service/model ports, repositories, and
  focused tests. Reuse `CreateWithCouponReservation`, coupon transitions,
  `ConfirmPayment`, and package snapshot/reward logic where their invariants
  match; do not create a parallel coupon engine.

## Acceptance criteria

1. `PrepareCheckoutOrder` validates UUID/package/currency, derives the canonical
   package and reward snapshot, applies the optional coupon for the trusted
   `user_id`, and returns exact original/final minor units plus reward quote.
2. The same idempotency key returns the same order/quote; reusing it with a
   different user, package, or coupon is rejected rather than silently replayed.
3. Preparing with a coupon atomically creates a pending order and live quota
   reservation; preparing without a coupon creates the equivalent durable
   pending order without coupon usage.
4. `ConfirmCheckoutOrder` is idempotent, transitions payment using the Stripe
   reference, consumes the coupon at the existing safe point, and returns only
   after Order fulfillment reaches a stable state.
5. `FailCheckoutOrder` is idempotent for unpaid pending orders and releases any
   reservation. It cannot roll a paid/fulfilling/fulfilled order backward.
6. The three RPCs remain internal gRPC methods with no grpc-gateway annotation.
7. Focused handler/service/repository tests cover no coupon, discount,
   complimentary rewards, quota race, expired reservation, replay mismatch,
   duplicate confirm/fail, and confirm-vs-fail ordering.
8. `GOWORK=off go test ./...`, `GOWORK=off go build -mod=readonly ./...`,
   dependency guard, and `git diff --check` pass and are recorded as task
   evidence.

## Likely affected files

- `Games-Labs-Order/go.mod`
- `Games-Labs-Order/go.sum`
- `Games-Labs-Order/internal/models/order.go`
- `Games-Labs-Order/internal/core/ports/services.go`
- `Games-Labs-Order/internal/core/ports/repositories.go`
- `Games-Labs-Order/internal/core/handlers/orderhdl/grpc.go`
- `Games-Labs-Order/internal/core/services/ordersvc/service.go`
- `Games-Labs-Order/internal/core/services/ordersvc/coupon.go`
- `Games-Labs-Order/internal/core/repositories/order.go`
- `Games-Labs-Order/internal/core/repositories/coupon.go`
- focused `_test.go` files beside those owners

## Risks and mitigations

- Reservation expiry between prepare and paid confirmation may exhaust quota.
  Keep the existing consume-time quota recheck and surface fulfillment failure;
  never grant rewards first.
- Internal RPCs accept a Wallet-supplied user id. Keep them unannotated and add
  a route-registration test proving they are not publicly exposed.
- Existing idempotency lookup returns a row by key alone. Verify immutable
  request identity before replaying it.

## Out of scope

- Wallet, Gateway, Stripe adapter, deployment, or Android edits.
- New public HTTP routes.


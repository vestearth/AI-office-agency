# TASK-EAR-298 — Settle Order state from signed Stripe outcomes

## Type / workstream / priority

Feature / backend / high

## Parent / epic

- Parent: TASK-EAR-295
- Epic: Coupon-aware Stripe checkout

## Goal

Make signed Stripe webhook outcomes confirm or fail the bound Order exactly
once, with Order—not Wallet—owning package and complimentary reward fulfillment.

## Scope

- Repository: `Games-Labs-Wallet` only.
- Depends on TASK-EAR-297.
- Extend existing signed Stripe callback, payment status, and retry behavior.
  Reuse the Order adapter and stored quote/order metadata from TASK-EAR-297.

## Acceptance criteria

1. Paid Checkout events call `ConfirmCheckoutOrder(order_id, payment_reference)`
   and do not execute Wallet's legacy local package-reward path for an
   Order-bound transaction.
2. Wallet marks `fulfillment_status=fulfilled` only after Order confirms a
   fulfilled durable order. Stored granted coin/diamond values come from the
   prepared immutable quote, not the current catalog.
3. If Stripe captured payment but Order confirmation/reward fulfillment fails,
   Wallet preserves `payment_status=paid`, sets `fulfillment_status=failed`,
   returns an error so Stripe retry remains possible, and never calls fail/release.
4. Expired, async-failed, payment-failed, and canceled events call
   `FailCheckoutOrder` only while the payment is unsettled, releasing the
   reservation without moving paid/fulfilled state backward.
5. Duplicate and out-of-order Stripe events are idempotent: no duplicate order
   confirmation, coupon consumption, or rewards; a late failure cannot undo a
   paid result; a retried paid event can recover failed fulfillment.
6. Create/status responses return the bound `order_id`; old transactions with
   no order binding retain deterministic legacy behavior.
7. Structured logs include payment transaction id, Order id, Stripe session or
   intent id, and failure stage without secrets or raw webhook bodies.
8. Focused state-matrix tests plus `GOWORK=off go test ./...`,
   `GOWORK=off go build -mod=readonly ./...`, and `git diff --check` pass and are
   recorded as task evidence.

## Likely affected files

- `Games-Labs-Wallet/internal/core/services/paymentsvc/stripe_callback.go`
- `Games-Labs-Wallet/internal/core/services/paymentsvc/package_fulfillment.go`
- `Games-Labs-Wallet/internal/core/services/paymentsvc/stripe_deposit.go`
- `Games-Labs-Wallet/internal/core/services/paymentsvc/service.go`
- `Games-Labs-Wallet/internal/core/handlers/paymenthdl/grpc.go`
- `Games-Labs-Wallet/internal/core/ports/adapters.go`
- `Games-Labs-Wallet/internal/adapters/orderadt/adapter.go`
- `Games-Labs-Wallet/internal/models/payment.go`
- focused Stripe callback/status `_test.go` files

## Risks and mitigations

- This is a money and fulfillment path. Require high-depth review and an
  explicit state-transition matrix covering every Stripe event class.
- Wallet calling Order while Order calls Wallet reward APIs can expose timeout
  or retry cycles. Preserve idempotency keys at both hops and avoid holding a
  local database transaction across the network call.
- Do not treat HTTP/gRPC success alone as fulfillment success; inspect Order's
  explicit returned state.

## Out of scope

- Gateway changes, deployment, production reconciliation, or Android edits.


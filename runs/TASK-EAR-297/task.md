# TASK-EAR-297 — Bind Stripe Checkout creation to the Order quote

## Type / workstream / priority

Feature / backend / high

## Parent / epic

- Parent: TASK-EAR-295
- Epic: Coupon-aware Stripe checkout

## Goal

Make Wallet prepare a durable Order before creating a packaged Stripe Checkout,
charge the exact Order quote, and return the bound `order_id` to the client.

## Scope

- Repository: `Games-Labs-Wallet` only.
- Depends on TASK-EAR-296 being merged and available in the target environment.
- Bump `shared-lib` to `v0.0.0-20260824045720-a2181ce77371`; update `go.mod` and
  `go.sum` together with no `replace` directive.
- Extend the existing Order adapter and Stripe checkout creation path. Preserve
  legacy no-package and non-Stripe provider behavior.

## Acceptance criteria

1. The gRPC handler maps additive request `coupon_code` into Wallet's internal
   input without trusting body `user_id`.
2. For a packaged Stripe deposit, Wallet calls `PrepareCheckoutOrder` with the
   authenticated user, package id, optional normalized coupon code, and the
   existing idempotency id before calling Stripe.
3. Wallet charges `final_payable_amount_minor_units` from Order. If client
   `amount` is present it must match that final quote in minor units; omission
   remains supported.
4. Stripe line item/discount metadata and Wallet transaction metadata retain
   `order_id`, original/final amounts, coupon code/type, and reward quote needed
   for replay and later settlement without recomputing mutable catalog data.
5. The create response returns the durable `order_id`; replaying the same
   idempotency id returns the same payment transaction, Order, and Checkout
   Session instead of reserving or minting duplicates.
6. If Stripe Session creation fails after prepare, Wallet calls
   `FailCheckoutOrder` to release the unpaid order/reservation and preserves the
   original provider error with cleanup context logged.
7. No-coupon packaged Stripe checkout still uses the Order quote and remains
   backward compatible. Plain deposits and UBIT/OneDay flows are unchanged.
8. Focused handler/service/adapter tests plus `GOWORK=off go test ./...`,
   `GOWORK=off go build -mod=readonly ./...`, dependency guard, and
   `git diff --check` pass and are recorded as task evidence.

## Likely affected files

- `Games-Labs-Wallet/go.mod`
- `Games-Labs-Wallet/go.sum`
- `Games-Labs-Wallet/internal/models/payment.go`
- `Games-Labs-Wallet/internal/core/ports/adapters.go`
- `Games-Labs-Wallet/internal/adapters/orderadt/adapter.go`
- `Games-Labs-Wallet/internal/core/handlers/paymenthdl/grpc.go`
- `Games-Labs-Wallet/internal/core/handlers/paymenthdl/response.go`
- `Games-Labs-Wallet/internal/core/services/paymentsvc/service.go`
- `Games-Labs-Wallet/internal/core/services/paymentsvc/stripe_deposit.go`
- `Games-Labs-Wallet/internal/adapters/stripeadt/adapter.go`
- focused `_test.go` files beside those owners

## Risks and mitigations

- Stripe can fail after Order reservation. Treat cleanup as a required part of
  the creation transaction boundary and test it explicitly.
- Float amounts can diverge from satang. Compare and transport minor units at
  the Order/Stripe boundary.
- Metadata is the minimal durable binding. Add a migration only if current
  repository constraints prove metadata cannot support indexed lookup/replay.

## Out of scope

- Signed webhook settlement, deployment, Gateway, or Android edits.


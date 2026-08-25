# TASK-EAR-295 — Deliver coupon-aware Stripe checkout end to end

## Type / workstream / priority

Feature / backend / high

## Sprint goal

Allow Mobile to submit an optional coupon before Stripe Checkout while Order
remains authoritative for price, coupon quota, durable order state, and reward
fulfillment.

## Committed scope

1. TASK-EAR-296 implements the internal Order checkout lifecycle.
2. TASK-EAR-297 binds Stripe Checkout creation to the Order quote.
3. TASK-EAR-298 settles or releases the Order from signed Stripe outcomes.
4. TASK-EAR-299 publishes and verifies the additive HTTP contract in Gateway.
5. TASK-EAR-300 performs authorized staging acceptance and writes the Mobile
   handoff without modifying `Games-Lab-Android/`.

The shared contract prerequisite is already merged as `shared-lib` PR #53,
merge commit `a2181ce773711488f97c5e2371df0d5574a4102c`, published Go pseudo-version
`v0.0.0-20260824045720-a2181ce77371`.

## Dependency graph

```text
TASK-EAR-296 Order lifecycle
  -> TASK-EAR-297 Wallet checkout creation
  -> TASK-EAR-298 Wallet Stripe settlement
  -> TASK-EAR-299 Gateway HTTP contract
  -> TASK-EAR-300 staging acceptance + Mobile handoff
```

## Acceptance criteria

1. Mobile can submit `coupon_code` on the existing payment-create endpoint and
   receive the durable `order_id` without a breaking route change.
2. Stripe charges the exact minor-unit quote prepared by Order; client amount,
   catalog amount, and coupon logic cannot diverge silently.
3. Coupon reservation, consumption, release, payment state, and reward grant
   remain idempotent across request retries and duplicate/out-of-order Stripe
   events.
4. Mobile success is reported only when `fulfillment_status=fulfilled`; a paid
   Stripe payment with failed Order fulfillment remains visible and retriable.
5. Existing no-coupon package checkout remains compatible.
6. Source/test, PR/merge, deployment, authenticated staging acceptance, and
   production readiness are reported as separate evidence layers.

## Deferred scope

- Production deployment or production coupon creation.
- Android source changes; `Games-Lab-Android/` is read-only.
- A new payment/order database schema unless implementation evidence proves
  metadata cannot durably carry the additive `order_id` and quote snapshot.
- Supporting coupons for non-package deposits or non-Stripe providers.

## Planning evidence

- `shared-lib/proto/orderpb/order.proto` owns unannotated
  `PrepareCheckoutOrder`, `ConfirmCheckoutOrder`, and `FailCheckoutOrder` RPCs.
- `shared-lib/proto/paymentpb/payment.proto` adds request `coupon_code` and
  response/status `order_id` fields.
- `Games-Labs-Order/internal/core/services/ordersvc/coupon.go` and
  `internal/core/repositories/coupon.go` already own coupon evaluation,
  reservation, consumption, and release primitives.
- `Games-Labs-Wallet/internal/core/services/paymentsvc/stripe_deposit.go` still
  prices from the package catalog and does not call the new Order lifecycle.
- `Games-Labs-Wallet/internal/core/services/paymentsvc/stripe_callback.go`
  currently grants package rewards inside Wallet and must not double-grant an
  Order-bound checkout.
- SocratiCode discovery was attempted through the workspace CLI/wrapper but was
  unavailable because the local npm cache contains root-owned files; current
  source files above are the planning source of truth.


# TASK-005: Purchase Package Flow with Wallet Fulfillment

## Overview
Implement the end-to-end purchase package flow in Games-Labs-Order: user selects a
purchase package (THB -> diamonds + coins), order is created with status pending,
payment confirmation triggers fulfillment via Wallet credit, and the order is marked
fulfilled. Includes idempotency to prevent duplicate fulfillment on payment retries.

## Type
feature

## Priority
high

## Target Service
Games-Labs-Order

## Target Files
- `Games-Labs-Order/internal/core/services/ordersvc/service.go`
- `Games-Labs-Order/internal/core/handlers/orderhdl/http.go`
- `Games-Labs-Order/internal/core/handlers/orderhdl/grpc.go`
- `Games-Labs-Order/internal/core/repositories/order.go`
- `Games-Labs-Order/internal/core/ports/services.go`
- `Games-Labs-Order/internal/core/ports/adapters.go`
- `Games-Labs-Order/internal/models/order.go`
- `Games-Labs-Order/migrations/004_add_fulfillment_fields.sql`

## Description
`CreateOrderFromPackage` already creates an order with `status=pending` and stores
a `package_snapshot`. But there is no fulfillment step — no Wallet call, no status
progression beyond pending/success/failed.

This task adds the full lifecycle:

1. **Extend `OrderStatus`** with finer states:
   - `pending` — order created, awaiting payment
   - `payment_confirmed` — PSP/callback confirmed payment received
   - `fulfilling` — Wallet credit in progress
   - `fulfilled` — Wallet credit succeeded, order complete
   - `failed` — payment or fulfillment failed
   - `refunded` — reversed (future use)

2. **Add fulfillment fields** (migration `004`):
   - `fulfillment_status VARCHAR(20)` — tracks Wallet call result
   - `idempotency_key VARCHAR(255) UNIQUE` — order-level key for dedup
   - `payment_reference VARCHAR(255)` — PSP transaction ID
   - `fulfilled_at TIMESTAMPTZ`
   - `wallet_reference VARCHAR(255)` — ledger ID returned by Wallet

3. **Wallet adapter** (`internal/core/ports/adapters.go` or new `walletadt`):
   - Interface for calling Wallet's `Credit` endpoint (HTTP or gRPC)
   - Method: `CreditUser(ctx, userID, currency, amount, source, metadata, idempotencyKey) (*Result, error)`
   - Idempotency key format: `order:<order_id>:<currency>` to prevent double-credit

4. **Fulfillment logic** in `ordersvc`:
   - `ConfirmPayment(ctx, orderID, paymentReference)`:
     - Load order, verify status is `pending`
     - Update to `payment_confirmed`
     - Call `FulfillOrder`
   - `FulfillOrder(ctx, orderID)`:
     - Load order + package snapshot
     - Call Wallet `RewardPackage(orderID, userID, diamonds, coins)` (TASK-007)
       which atomically credits both currencies in a single DB transaction
     - On success: update order to `fulfilled`, store `wallet_reference`, set `fulfilled_at`
     - On Wallet failure: update `fulfillment_status=failed`, keep order as `payment_confirmed` (retriable)

5. **Idempotency handling**:
   - `ConfirmPayment` is idempotent: if order is already `fulfilled`, return success
   - If order is `payment_confirmed` but `fulfillment_status=failed`, retry fulfillment
   - Wallet `RewardPackage` uses `reward:<order_id>` as its idempotency key (defined in TASK-007)

6. **HTTP endpoint**:
   - `POST /api/v1/orders/{id}/confirm-payment` — body: `{ "payment_reference": "..." }`
   - `POST /webhooks/payment-callback` — PSP webhook that maps to `ConfirmPayment`

## Acceptance Criteria
- [ ] `OrderStatus` includes `payment_confirmed`, `fulfilling`, `fulfilled`, `refunded`
- [ ] Migration adds `fulfillment_status`, `idempotency_key`, `payment_reference`, `fulfilled_at`, `wallet_reference`
- [ ] Wallet adapter interface is defined and implemented (HTTP client to Wallet service)
- [ ] `ConfirmPayment` transitions order from `pending` to `payment_confirmed` and triggers fulfillment
- [ ] `FulfillOrder` credits diamonds and/or coins via Wallet's `RewardPackage` composite operation (TASK-007)
- [ ] Duplicate `ConfirmPayment` calls on an already-fulfilled order return success without re-crediting
- [ ] Failed fulfillment leaves order in `payment_confirmed` with `fulfillment_status=failed` for retry
- [ ] `package_snapshot` is used for fulfillment amounts (not live package data) to prevent mid-flight changes

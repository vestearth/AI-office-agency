# TASK-009: End-to-End Verification and Reconciliation

## Overview
Verify the full purchase packages system across Orders, Wallet, and Missions with
integration test scenarios covering happy paths, edge cases, failure recovery,
idempotency, and cross-service reconciliation.

## Type
test

## Priority
medium

## Target Service
Games-Labs-Order, Games-Labs-Wallet, Games-Labs-Missions

## Target Files
- `Games-Labs-Order/internal/core/services/ordersvc/service_test.go`
- `Games-Labs-Wallet/internal/core/services/walletsvc/service_test.go`
- `Games-Labs-Order/tests/integration/` (new)
- `Games-Labs-Wallet/tests/integration/` (new)

## Description
After TASK-002 through TASK-008 are complete, run structured verification to confirm
the system works correctly end-to-end.

### Test scenarios:

**Purchase Package — Happy Path**
1. Admin creates a purchase package (100 THB -> 50 diamonds + 500 coins)
2. User lists packages, sees the new package
3. User creates a purchase order (status: pending)
4. Payment callback confirms payment (status: payment_confirmed -> fulfilled)
5. Wallet balance increases by exactly 50 diamonds and 500 coins
6. Order record shows `fulfilled_at`, `wallet_reference`, `payment_reference`

**Purchase Package — Duplicate Callback**
1. Complete a purchase as above
2. Send the same payment callback again
3. Verify: order stays `fulfilled`, wallet balance does not increase again
4. Verify: Wallet idempotency key `reward:<order_id>` replays correctly (returns prior result)

**Purchase Package — Fulfillment Failure and Retry**
1. Create order and confirm payment
2. Simulate Wallet being unavailable during fulfillment
3. Verify: order is `payment_confirmed` with `fulfillment_status=failed`
4. Retry fulfillment
5. Verify: order transitions to `fulfilled`, wallet balance is correct

**Exchange Package — Happy Path**
1. User has 200 diamonds
2. User exchanges with package `ex_100` (100 diamonds -> 2000 coins + 10% bonus)
3. Verify: diamonds decreased by 100, coins increased by 2200
4. Order is `fulfilled` with correct `package_snapshot`

**Exchange Package — Insufficient Diamonds**
1. User has 50 diamonds
2. User tries to exchange with `ex_100` (requires 100 diamonds)
3. Verify: order status is `failed`, error message is clear
4. Verify: no balance changes occurred

**Exchange Package — With Coin Booster Pass**
1. User has active `coin_booster` pass
2. User exchanges `ex_25` (25 diamonds -> 500 coins + 0% base bonus + 10% booster)
3. Verify: coins credited = 500 + 50 = 550
4. Verify: `package_snapshot` records `bonus_percent: 10`

**Inactive/Expired Package**
1. Admin deactivates a package
2. User tries to create order with that package
3. Verify: order creation rejected with clear error
4. Repeat with an expired package (past `expires_at`)

**Concurrent Exchange Requests**
1. User has exactly 100 diamonds
2. Send two exchange requests simultaneously for `ex_100`
3. Verify: exactly one succeeds, one fails with insufficient diamonds
4. Verify: final diamond balance is 0, coin balance reflects one exchange

**Reconciliation Checks**
1. After running all scenarios, query Orders for all `fulfilled` orders
2. For each order, verify a matching Wallet transaction exists with the same
   `order_id` in metadata and correct amounts
3. Sum of all Wallet credits/debits for a user should match their current balance
4. No orphaned transactions (Wallet entries without matching Orders records)

### Verification commands:
- `go test ./...` in Games-Labs-Order
- `go test ./...` in Games-Labs-Wallet
- Manual API tests with curl/httpie against running services
- DB queries to cross-reference `orders` <-> `wallet_transactions` by order_id

## Acceptance Criteria
- [ ] Purchase package happy path: paid order fulfills once, wallet balance correct
- [ ] Duplicate payment callback does not double-credit (idempotent fulfillment)
- [ ] Failed fulfillment is retriable and eventually succeeds
- [ ] Exchange package happy path: diamonds debited, coins credited with bonus
- [ ] Insufficient diamonds exchange fails cleanly without balance changes
- [ ] Coin booster pass adds bonus percent to exchange correctly
- [ ] Inactive/expired packages are rejected at order creation
- [ ] Concurrent exchange requests: exactly one succeeds for borderline balance
- [ ] All fulfilled orders have matching Wallet transaction records (reconciliation)
- [ ] `go test ./...` passes in both Games-Labs-Order and Games-Labs-Wallet

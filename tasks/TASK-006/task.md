# TASK-006: Diamond Exchange Flow with Idempotency

## Overview
Implement the diamond-to-coin exchange flow in Games-Labs-Order: user selects an
exchange package, Orders validates availability and calls Wallet to atomically debit
diamonds and credit coins, then marks the order fulfilled. Uses Wallet's composite
`ExchangeDiamondsToCoins` operation (from TASK-007) for atomicity.

## Type
feature

## Priority
high

## Target Service
Games-Labs-Order

## Target Files
- `Games-Labs-Order/internal/core/services/ordersvc/service.go`
- `Games-Labs-Order/internal/core/handlers/orderhdl/http.go`
- `Games-Labs-Order/internal/core/ports/adapters.go`
- `Games-Labs-Order/internal/models/order.go`

## Description
Exchange packages use `PackageType=exchange` and `OrderType=exchange_coin`.
`CreateOrderFromPackage` already creates the order with `amount=PriceDiamonds`,
`currency=DIAMOND`. But there is no Wallet integration to actually execute the exchange.

Missions' `ExchangeDiamonds` in `store_service.go` shows the reference implementation:
- Debit `rate.Diamonds` from user
- Credit `coinOut = rate.Coin + floor(rate.Coin * BonusPercent/100)` to user
- If user has `coin_booster` pass, add +10% to BonusPercent

This task ports that logic to Orders with proper separation:

1. **Exchange order creation** (`POST /api/v1/orders/exchange`):
   - Validate package is active and within time window
   - Create order with `type=exchange_coin`, `status=pending`
   - Store `package_snapshot` including `bonus_percent`
   - No external payment needed — diamonds are the "payment"

2. **Exchange fulfillment** (immediate, no PSP callback):
   - After order creation, immediately attempt fulfillment
   - Call Wallet `ExchangeDiamondsToCoins(orderID, userID, diamonds, coins)` (TASK-007)
   - `coins` = `reward_coins + floor(reward_coins * bonus_percent / 100)`
   - On success: mark order `fulfilled`
   - On insufficient diamonds: mark order `failed`, return clear error

3. **Bonus percent handling**:
   - Base `bonus_percent` comes from the exchange package definition
   - Additional bonus from passes/boosters: Orders should check if user has active
     `coin_booster` pass. Options:
     - (A) Orders calls Missions to check pass status and adds +10%
     - (B) Client sends pass context and Orders validates
     - (C) Bonus pass logic stays in Missions; Orders only applies package base bonus
   - Recommended: option (A) — Orders calls a lightweight Missions endpoint
     `GET /passes/active?user_id=X&pass_type=coin_booster` or gRPC equivalent

4. **Idempotency**:
   - `idempotency_key` on the order prevents duplicate exchange creation
   - Wallet's composite operation uses `order:<order_id>` as its idempotency key
   - If client retries with same idempotency key, return existing order result

5. **HTTP endpoint**:
   - `POST /api/v1/orders/exchange` — body: `{ "user_id": "...", "package_id": "...", "idempotency_key": "..." }`
   - Returns order with fulfillment result inline (since exchange is synchronous)

## Acceptance Criteria
- [ ] `POST /api/v1/orders/exchange` creates and immediately fulfills an exchange order
- [ ] Exchange uses Wallet's `ExchangeDiamondsToCoins` composite operation (from TASK-007)
- [ ] Bonus percent is computed as `base_bonus + booster_bonus` on the base `reward_coins`
- [ ] Insufficient diamonds returns a clear error and order status `failed`
- [ ] Inactive or expired package returns rejection before order creation
- [ ] Idempotency key prevents duplicate exchange orders
- [ ] Order `package_snapshot` captures the bonus percent used at time of exchange
- [ ] Example: exchange package `ex_100` (100 diamonds -> 2000 coins + 10% bonus) yields 2200 coins

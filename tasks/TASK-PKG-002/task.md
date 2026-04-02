# TASK-PKG-002: Implement Order Fulfillment Logic & Bonus calculation in Games-Labs-Order

## Description
This task involves implementing the order fulfillment engine for both `Purchase Packages` and `Exchange Packages`. It bridges `Games-Labs-Order` with `Games-Labs-Wallet` using the atomic operations created in TASK-PKG-001.

## Objectives
1. **Fulfillment Logic**: Implement logic to execute an order created via `CreateOrderFromPackage`. It should call the newly created composite Wallet endpoints (`RewardPackage` for purchases, `ExchangeDiamondsToCoins` for exchanges).
2. **Idempotency & Retry**: Ensure all outbound requests to `Games-Labs-Wallet` use the Order ID as the idempotency key to prevent double charging or double rewarding.
3. **Bonus Calculation**: Integrate logic to query a user's active Booster Pass (from `Games-Labs-Missions` or User service) during the calculation of `RewardCoins` (e.g., base package coins + bonus percent applied).

## Technical Requirements
- Update `Games-Labs-Order/internal/core/services/ordersvc/service.go`.
- Ensure proper logging and error handling for distributed transactions.
- Handle state transitions of the order (`Pending` -> `Paid` or `Failed`).

## Assigned Agent
`dev`
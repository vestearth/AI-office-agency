# TASK-PKG-001: Implement Wallet Composite Operations (Exchange & Reward with Atomicity)

## Description
This task is part of the "Purchase Packages Architecture" implementation. The `Games-Labs-Wallet` service currently supports basic single-currency `Credit` and `Debit` via idempotency keys, but lacks composite atomic operations necessary for package exchanging and purchasing flows from the `Games-Labs-Order` service.

## Objectives
1. **ExchangeDiamondsToCoins**: Implement a business-level transaction inside `Games-Labs-Wallet` that atomically debits diamonds and credits coins using a single idempotency key (derived from the `order_id`).
2. **RewardPackage**: Implement a business-level transaction to atomically credit multiple currencies (e.g., both diamonds and coins) concurrently if a package rewards both.
3. **Protobuf & Handlers**: Add the necessary gRPC RPC definitions (`walletpb.proto`) in `shared-lib/proto` and `wallet_http.go` endpoints to expose these composite operations securely to internal services.

## Technical Requirements
- Utilize existing patterns for `pgx` atomic transactions in `/internal/repositories/wallet.go`.
- Ensure the input requests include an `IdempotencyKey`. If a sub-transaction fails, the whole block must rollback.
- Update `proto` definitions in `shared-lib` using `make buf` and wire up the gRPC and HTTP gateway servers for the newly added Wallet endpoints.

## Assigned Agent
`dev`
# TASK-002: Define Domain Boundaries for Purchase Packages

## Overview
Establish clear ownership boundaries between Orders, Wallet, and Missions services
for the purchase packages feature. Orders owns package catalog and order lifecycle;
Wallet owns balances, ledger, and atomic transactions; Missions becomes a consumer only.

## Type
architecture

## Priority
high

## Target Service
Games-Labs-Order, Games-Labs-Wallet, Games-Labs-Missions

## Target Files
- `Games-Labs-Order/internal/models/order.go`
- `Games-Labs-Wallet/internal/core/ports/services.go`
- `Games-Labs-Missions/internal/services/store_service.go`
- `shared-lib/proto/orderpb/order.proto`

## Description
Currently three services have overlapping responsibilities around economy/packages:

- **Missions** holds `CoinPackage`, `ExchangeRate`, seed data, purchase/exchange
  flows, and calls Wallet directly from `store_service.go`.
- **Orders** has `OrderPackage` model, `order_packages` table with seed data,
  `CreateOrderFromPackage`, but no fulfillment or Wallet integration. The admin
  handler (`adminorderhdl`) is an empty stub.
- **Wallet** provides `Credit`/`Debit` with idempotency and atomic
  `ApplyTransaction` but has no composite operations for multi-currency moves.

This task documents and enforces the target architecture:

1. **Orders** is the single owner of:
   - Package catalog (`order_packages` table, CRUD, activation lifecycle)
   - Order records and lifecycle (pending -> paid -> fulfilled -> refunded)
   - Payment reference, idempotency-key-to-order mapping, fulfillment orchestration
   - Calling Wallet to execute credit/debit as part of fulfillment

2. **Wallet** is the single owner of:
   - User balances (coin, diamonds, points)
   - Transaction ledger (`wallet_transactions`)
   - Atomic balance mutations via `ApplyTransaction`
   - Idempotency at the transaction level
   - Composite operations (added in TASK-007) for multi-currency atomicity

3. **Missions** retains only:
   - Mission/progression/quest logic
   - Reward orchestration (deciding *what* to grant, then calling Orders or Wallet)
   - Read-only access to package catalog from Orders for UI display
   - Pass/avatar inventory (unless later migrated)

Naming reuse: `CoinPackage` and `ExchangeRate` concepts from Missions map to
`OrderPackage` with `PackageType` purchase/exchange in Orders. Seed data values
should be migrated to Orders' `order_packages` table.

## Acceptance Criteria
- [ ] A written architecture decision record (ADR or section in repo docs) defines ownership per service
- [ ] `OrderPackage` model in Orders covers both purchase and exchange package types (already exists; confirm fields align)
- [ ] `OrderType` enum in Orders includes `topup_crystal` and `exchange_coin` (already exists; confirm)
- [ ] `PackageType` enum in Orders includes `purchase` and `exchange` (already exists; confirm)
- [ ] No new economy/balance logic is added to Missions after this task
- [ ] Proto `order.proto` is reviewed and gaps identified (e.g. missing `package_id`, `package_snapshot` on proto `Order` message)

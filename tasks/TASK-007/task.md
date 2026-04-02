# TASK-007: Wallet Composite Operations for Package Fulfillment

## Overview
Add composite operations to Games-Labs-Wallet that execute multi-currency balance
changes atomically within a single database transaction: `RewardPackage` (credit
diamonds + coins from a purchase) and `ExchangeDiamondsToCoins` (debit diamonds +
credit coins from an exchange). Both operations use order-scoped idempotency.

## Type
feature

## Priority
high

## Target Service
Games-Labs-Wallet

## Target Files
- `Games-Labs-Wallet/internal/core/ports/services.go`
- `Games-Labs-Wallet/internal/core/ports/repositories.go`
- `Games-Labs-Wallet/internal/core/services/walletsvc/service.go`
- `Games-Labs-Wallet/internal/repositories/wallet.go`
- `Games-Labs-Wallet/internal/core/handlers/wallethdl/wallet_handler.go`
- `Games-Labs-Wallet/cmd/main.go`

## Description
Currently, crediting diamonds and coins requires two separate `Credit` calls with
independent `ApplyTransaction` calls. If one succeeds and the other fails, the user
has a partial reward and Orders must implement compensating logic.

This task adds two composite operations that run in a single SQL transaction:

### 1. `RewardPackage` (for purchase package fulfillment)

```go
RewardPackage(ctx context.Context, req RewardPackageRequest) (*RewardPackageResult, error)

type RewardPackageRequest struct {
    UserID         string
    OrderID        string // used as idempotency scope
    Diamonds       int64  // 0 means skip diamond credit
    Coins          int64  // 0 means skip coin credit
    Source         string // e.g. "purchase_package"
    Metadata       map[string]interface{}
}

type RewardPackageResult struct {
    CoinAfter     int64
    DiamondsAfter int64
    LedgerIDs     []string // one per currency credited
}
```

Implementation:
- Single DB transaction: lock wallet row `FOR UPDATE`
- Idempotency check using key `reward:<OrderID>`
- If diamonds > 0: insert CREDIT ledger row for diamonds, update `wallets.diamonds`
- If coins > 0: insert CREDIT ledger row for coins, update `wallets.coin_amount`
- Both ledger rows share the same `OrderID` in metadata
- Commit or rollback as one unit

### 2. `ExchangeDiamondsToCoins` (for exchange package fulfillment)

```go
ExchangeDiamondsToCoins(ctx context.Context, req ExchangeRequest) (*ExchangeResult, error)

type ExchangeRequest struct {
    UserID         string
    OrderID        string
    DiamondsToDebit int64
    CoinsToCredit   int64
    Source          string // e.g. "exchange_package"
    Metadata        map[string]interface{}
}

type ExchangeResult struct {
    CoinAfter     int64
    DiamondsAfter int64
    DebitLedgerID string
    CreditLedgerID string
}
```

Implementation:
- Single DB transaction: lock wallet row `FOR UPDATE`
- Idempotency check using key `exchange:<OrderID>`
- Verify diamonds >= DiamondsToDebit (return `ErrInsufficientFunds` if not)
- Insert DEBIT ledger row for diamonds, update `wallets.diamonds`
- Insert CREDIT ledger row for coins, update `wallets.coin_amount`
- Both ledger rows reference the same order in metadata
- Commit or rollback as one unit

### 3. HTTP/gRPC endpoints

- `POST /wallets/reward-package` — JSON body maps to `RewardPackageRequest`
- `POST /wallets/exchange-diamonds` — JSON body maps to `ExchangeRequest`
- gRPC: add corresponding RPCs to `walletpb` if inter-service calls use gRPC

### 4. Repository layer

Add `RewardPackage` and `ExchangeDiamondsToCoins` to `WalletRepository` interface.
Implementation follows the same pattern as `TransferCoin`: single transaction,
ordered lock, multiple ledger inserts, balance updates, idempotent replay.

## Acceptance Criteria
- [ ] `RewardPackage` credits diamonds and coins in a single DB transaction
- [ ] `ExchangeDiamondsToCoins` debits diamonds and credits coins in a single DB transaction
- [ ] Both operations are idempotent: replaying with the same `OrderID` returns prior result without duplicate mutations
- [ ] `ExchangeDiamondsToCoins` returns `ErrInsufficientFunds` if diamond balance is too low
- [ ] Partial failure is impossible: either both currencies are updated or neither is
- [ ] Ledger rows from the same composite operation share `order_id` in metadata for reconciliation
- [ ] HTTP endpoints are added and wired in `main.go`
- [ ] Existing `Credit`/`Debit` behavior is unchanged (no regression)

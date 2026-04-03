# TASK-013: Spendable Points — shared-lib Proto + Wallet Service Foundation

## Type
feature

## Priority
high

## Description
Introduce the Spendable Points balance. Points are earned passively at 1 Point
per 5,000 coin turnover (DEBIT/BET) and stored in `wallets.points`. The Wallet
exposes a safe, idempotent `RedeemPoints` RPC that **only deducts points** — no
in-game currency is credited. Level eligibility is NOT checked here.

This is Subtask 1 of the Points Redemption Epic. TASK-014 is blocked until
this task is approved.

## Scope
- `shared-lib/proto/walletpb/wallet.proto` — add `RedeemPoints` RPC + messages
- `Games-Labs-Wallet` — accumulation hook, `AwardPoints`, `RedeemPoints`,
  gRPC/HTTP handlers, DB migration

## Current State
- `wallets.points` column exists; `AwardPoints`/`RedeemPoints` are stubbed with
  `"not implemented"` errors.
- `coin_turnover` accumulation already hooks into `ApplyTransaction` at
  `wallet.go:206-209` — points award goes in the same block.
- `walletpb/wallet.proto` has no `RedeemPoints` RPC yet.

## Acceptance Criteria
- `walletpb/wallet.proto` has `RedeemPoints` RPC with `POST /api/v1/wallet/redeem-points`.
- Go bindings regenerated; `shared-lib` version bumped.
- Every DEBIT/BET coin transaction increments `wallets.points` by `floor(amount / 5000)`.
- `AwardPoints` increments balance — covered by unit test.
- `RedeemPoints` atomically deducts points, is idempotent, returns `ErrInsufficientPoints` when insufficient — covered by unit test.
- `RedeemPoints` does NOT credit any coin or diamond balance.
- gRPC `RedeemPoints` returns `409` on `ErrInsufficientPoints`.
- HTTP `POST /wallets/redeem` returns `402` on `ErrInsufficientPoints`.
- DB migration creates `wallet_points_ledger` with UNIQUE `idempotency_key`.
- `go build ./...` and `go test ./...` pass in `Games-Labs-Wallet`.

## Next Action
Run `dev-2` to implement all objectives, then hand off to `reviewer`.

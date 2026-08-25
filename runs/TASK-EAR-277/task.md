# TASK-EAR-277 — Starting coins come only from Free Coin

## Type

bugfix

## Workstream

backend

## Priority

medium

## Created

2026-08-18

## Goal

New wallets must start at **0**. The only first-time coins are the Free Coin
grant on `user.registered`. Delete `defaultUserCoinBalance` (hardcoded 1000)
so a live Free Coin amount of 100 no longer produces 1100.

## Verified current state (2026-08-18)

- `Games-Labs-Wallet/internal/repositories/wallet.go` inserts
  `defaultUserCoinBalance = 1000` in `CreateWalletForUser`.
- RabbitMQ then calls `GrantFreeCoinToNewUser` (idempotent `RewardPackage`,
  key `free_coin:<user_id>`). Seed default for config is 0; live amount is
  admin-configured.
- QA: new signup showed 1100 while Free Coin page showed 100.

## Acceptance criteria

1. `defaultUserCoinBalance` is gone.
2. `CreateWalletForUser` inserts `coin_amount = 0` (same as other wallet
   ensure-exists paths). Do **not** fold the Free Coin amount into the INSERT.
3. Registration still creates the wallet, then grants via
   `GrantFreeCoinToNewUser`. Amount 0 still means promotion off.
4. Focused regression test fails while the 1000 seed exists and passes after.
5. Missions `ClaimFirstRegister` comment and knowledge-base notes match the
   new source of truth. Existing wallets are not retroactively debited.

## Out of scope

- Android copy (read-only).
- Changing Free Coin admin API or grant ledger.
- Retroactive correction of already-seeded 1000 balances.

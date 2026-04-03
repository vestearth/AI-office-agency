# TASK-014: Spendable Points — Order Reward-Claim Flow + API Gateway Route

## Type
feature

## Priority
high

## Depends On
**TASK-013 must be approved first.**

## Description
Using the Spendable Points foundation from TASK-013, implement the full external
reward redemption flow.

The Order service:
1. Checks User Level >= 5 (via User service).
2. Deducts `price_points` from the user's Wallet via `RedeemPoints` gRPC.
3. Creates an Order with status `payment_confirmed` — **no in-game currency is
   credited**. Admin fulfills the external reward manually later.

## Scope
- `Games-Labs-Order` — `PackageTypeReward`, `price_points`, `UserAdapter`,
  `WalletAdapter.RedeemPoints`, `CreateRewardOrder`, HTTP handler, migration
- `api-gateway` — new `POST /api/v1/orders/reward` route under authenticated group

## Current State
- `PackageTypeReward` does not exist in `models/order.go`.
- `OrderPackage` has no `price_points` field.
- `internal/adapter/useradt/useradt.go` is empty (package declaration only).
- `WalletAdapter` has no `RedeemPoints` method.
- `api-gateway/gateway/http.go` proxies Order routes via `SimpleProxy`.

## Acceptance Criteria
- `PackageTypeReward` constant exists in `models/order.go`.
- `OrderPackage` and `UpsertOrderPackageRequest` have `price_points int64`.
- `UserAdapter.GetUserLevel` implemented and mock-tested.
- `WalletAdapter.RedeemPoints` implemented.
- `CreateRewardOrder` enforces Level >= 5 before any wallet operation.
- `CreateRewardOrder` calls `RedeemPoints` only — no `RewardPackage` or coin credit.
- Order is created with status `payment_confirmed` after successful point deduction.
- `POST /api/v1/orders/reward` returns `201` on success.
- `POST /api/v1/orders/reward` returns `402` when points are insufficient.
- `POST /api/v1/orders/reward` returns `403` when user level < 5.
- Route is registered in `api-gateway` under the authenticated `userOrders` group.
- DB migration adds `price_points` to `order_packages`.
- `go build ./...` and `go test ./...` pass in `Games-Labs-Order` and `api-gateway`.

## Next Action
Run `dev` after TASK-013 is approved, then hand off to `reviewer`.

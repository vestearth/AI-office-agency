# TASK-014: Spendable Points — Order Reward-Claim Flow + API Gateway Route

## Epic
Points Redemption System (Spendable Points to External Rewards)

## Type
feature

## Priority
high

## Depends On
**TASK-013 must be approved first.** This task requires the new `RedeemPoints`
gRPC from `walletpb` and the updated `shared-lib` bindings.

## Target Services
- `Games-Labs-Order` — new `PackageTypeReward`, reward-claim order flow
- `api-gateway` — new authenticated route for reward redemption

---

## Overview
Using the Spendable Points foundation from TASK-013, implement the full
**external reward redemption flow**:

1. Admin creates a `PackageTypeReward` package (e.g. `VOUCHER_5THB`, priced at
   50 Points).
2. User calls `POST /api/v1/orders/reward` with a `package_id`.
3. Order service checks User Level >= 5 (via User service).
4. Order service deducts `price_points` from the user's Wallet via the new
   `RedeemPoints` gRPC.
5. Order is created with status `payment_confirmed` and **left there** — no
   in-game item or coin is credited. Admin fulfills the external reward manually
   later.

---

## Business Rules
- **Level gate**: User must be Level >= 5. Check via `GET /users/{id}/stats`
  on the User service **before** deducting anything.
- **Payment currency**: `PackageTypeReward` packages are purchased with
  `price_points` (int64). Fields `price_amount` / `price_currency` /
  `price_diamonds` are unused for this package type.
- **No in-game reward**: `reward_coins` and `reward_diamonds` are `0` for
  reward packages. The Wallet is NOT called to credit anything after point
  deduction.
- **Final order state**: After successful point deduction the order status is
  `payment_confirmed`. It stays there until Admin manually fulfills it.
- **Idempotency**: Point deduction must be idempotent using the order's
  `idempotency_key`.
- **Error handling**:
  - `402 Payment Required` — insufficient points.
  - `403 Forbidden` — user level < 5.
  - `404 Not Found` — package not found or not active.
  - `409 Conflict` — duplicate `idempotency_key` (already redeemed).

---

## Current State (from code audit)
- `models/order.go` has `PackageTypePurchase` and `PackageTypeExchange`.
  `PackageTypeReward` does not exist.
- `OrderPackage` has no `price_points` field.
- `internal/adapter/useradt/useradt.go` exists but is empty (package declaration only).
- `ports/adapters.go` has `WalletAdapter` with `ExchangeDiamondsToCoins` and
  `RewardPackage` only — no `RedeemPoints`.
- `api-gateway/gateway/http.go` currently routes all `/api/*` to the gRPC mux
  via a single catch-all. Order HTTP routes are registered in
  `Games-Labs-Order/cmd/main.go` and proxied via `SimpleProxy`. The new route
  follows the same pattern.

---

## Objectives

### 1. Games-Labs-Order: `PackageTypeReward` and `price_points`
In `internal/models/order.go`:
- Add `PackageTypeReward PackageType = "reward"`.
- Add `PricePoints int64` to `OrderPackage` with `json:"price_points"`.
- Add `PricePoints int64` to `UpsertOrderPackageRequest` with `json:"price_points"`.
- Add `CreateRewardOrderRequest` struct:

```go
type CreateRewardOrderRequest struct {
    UserID         uuid.UUID
    PackageID      string
    IdempotencyKey string
}
```

- Add sentinel errors:

```go
var ErrInsufficientPoints = errors.New("insufficient points")
var ErrInsufficientLevel  = errors.New("user level too low for reward redemption")
```

### 2. Games-Labs-Order: User adapter
Implement `internal/adapter/useradt/useradt.go` (currently empty):

```go
// UserAdapter fetches user stats from the User service.
type userAdapter struct { baseURL string }

func New(baseURL string) ports.UserAdapter { ... }

func (a *userAdapter) GetUserLevel(ctx context.Context, userID string) (int, error) {
    // GET {baseURL}/users/{userID}/stats
    // parse response JSON field "level" (int)
}
```

Add `UserAdapter` interface to `ports/adapters.go`:

```go
type UserAdapter interface {
    GetUserLevel(ctx context.Context, userID string) (int, error)
}
```

Add `USER_HTTP_URL` to `configs/config.go` following the same pattern as
`ORDER_HTTP_URL`.

### 3. Games-Labs-Order: Wallet adapter — `RedeemPoints`
In `internal/adapter/walletadt/walletadt.go`, add:

```go
func (a *walletAdapter) RedeemPoints(
    ctx context.Context,
    userID string,
    points int64,
    reason string,
    idempotencyKey string,
) error {
    // POST {WALLET_HTTP_URL}/wallets/redeem
    // body: { user_id, points, reason, idempotency_key }
    // return ErrInsufficientPoints on 402
}
```

Add `RedeemPoints` to the `WalletAdapter` interface in `ports/adapters.go`.

### 4. Games-Labs-Order: Service method `CreateRewardOrder`
Add to `ports.OrderService` and implement in `ordersvc/service.go`:

```
CreateRewardOrder(ctx, req CreateRewardOrderRequest) (*Order, error)
```

Flow:
1. Load package by `PackageID`; verify `Type == PackageTypeReward` and `Active == true`.
2. Call `UserAdapter.GetUserLevel(ctx, userID)`.
   - Return `ErrInsufficientLevel` if `level < 5`.
3. Call `WalletAdapter.RedeemPoints(ctx, userID, pkg.PricePoints, "external_reward", req.IdempotencyKey)`.
   - Propagate `ErrInsufficientPoints` to the handler.
4. Create an `Order` row with:
   - `Type = OrderRewardClaim`
   - `Status = StatusPaymentConfirmed`  ← set directly, no pending→confirmed transition needed
   - `PackageSnapshot` = serialized package
   - `IdempotencyKey = req.IdempotencyKey`
   - `Amount = float64(pkg.PricePoints)`, `Currency = "POINTS"`
5. Return the created order.

**No `RewardPackage` or any Wallet credit call is made.** The order stays at
`payment_confirmed` until Admin fulfills it externally.

### 5. Games-Labs-Order: HTTP handler
In `internal/core/handlers/orderhdl/http.go`, add:

```
POST /api/v1/orders/reward  →  CreateRewardOrderHTTP
```

Request body (JSON):
```json
{ "package_id": "<string>", "idempotency_key": "<string>" }
```

`user_id` is extracted from the `X-User-ID` header (set by the gateway auth
middleware).

Response codes:
- `201 Created` — order created successfully, return the `Order` object.
- `402 Payment Required` — insufficient points.
- `403 Forbidden` — user level < 5.
- `404 Not Found` — package not found or inactive.
- `409 Conflict` — idempotency key already used.

Register the route in `cmd/main.go`:
```go
mux.HandleFunc("/api/v1/orders/reward", oh.CreateRewardOrderHTTP)
```

### 6. api-gateway: New route
In `api-gateway/gateway/http.go`, add under the existing `userOrders` group
(which already applies `middleware.Auth` and rate limiting):

```go
userOrders.POST("/orders/reward", orderProxy)
```

This exposes `POST /api/v1/orders/reward` to authenticated users.

### 7. Games-Labs-Order: DB migration
Add a migration that adds `price_points` to `order_packages`:

```sql
ALTER TABLE order_packages
  ADD COLUMN IF NOT EXISTS price_points BIGINT NOT NULL DEFAULT 0;
```

---

## Acceptance Criteria
- [ ] `PackageTypeReward` constant exists in `models/order.go`.
- [ ] `OrderPackage` and `UpsertOrderPackageRequest` have `price_points int64`.
- [ ] `UserAdapter.GetUserLevel` is implemented and tested with a mock HTTP server.
- [ ] `WalletAdapter.RedeemPoints` is implemented.
- [ ] `CreateRewardOrder` enforces Level >= 5 **before** any wallet operation.
- [ ] `CreateRewardOrder` calls `RedeemPoints` only — no `RewardPackage` or coin credit call is made.
- [ ] Order is created with status `payment_confirmed` after successful point deduction.
- [ ] `POST /api/v1/orders/reward` returns `201` on success with the order object.
- [ ] `POST /api/v1/orders/reward` returns `402` when points are insufficient.
- [ ] `POST /api/v1/orders/reward` returns `403` when user level < 5.
- [ ] Route is registered in `api-gateway` under the authenticated `userOrders` group.
- [ ] DB migration adds `price_points` column to `order_packages`.
- [ ] `go build ./...` and `go test ./...` pass in `Games-Labs-Order` and `api-gateway`.

---

## Technical Notes
- **No in-game reward.** Do not call `WalletAdapter.RewardPackage` anywhere in
  this flow. The order sits at `payment_confirmed` awaiting Admin action.
- The level check calls the User service synchronously. If the User service is
  down, reward orders will fail with a 5xx. This is acceptable for v1.
- `USER_HTTP_URL` must be added to `configs/config.go` and wired into the
  service constructor in `cmd/main.go`.
- Follow the existing `CreateOrderFromPackage` pattern for order creation and
  idempotency handling.
- The `api-gateway/gateway/http.go` currently has a single gRPC mux catch-all
  for `/api/*`. Order service routes are HTTP-proxied via `SimpleProxy`, not
  gRPC-gateway. The new route must follow the `userOrders.POST(...)` pattern
  that already exists for `order-packages`.

---

## Files to Create / Modify
| File | Action |
|------|--------|
| `Games-Labs-Order/internal/models/order.go` | add `PackageTypeReward`, `PricePoints`, `CreateRewardOrderRequest`, sentinel errors |
| `Games-Labs-Order/internal/core/ports/adapters.go` | add `UserAdapter` interface; add `RedeemPoints` to `WalletAdapter` |
| `Games-Labs-Order/internal/adapter/useradt/useradt.go` | implement `UserAdapter` |
| `Games-Labs-Order/internal/adapter/walletadt/walletadt.go` | add `RedeemPoints` |
| `Games-Labs-Order/internal/core/ports/services.go` | add `CreateRewardOrder` |
| `Games-Labs-Order/internal/core/services/ordersvc/service.go` | implement `CreateRewardOrder` |
| `Games-Labs-Order/internal/core/handlers/orderhdl/http.go` | add `CreateRewardOrderHTTP` |
| `Games-Labs-Order/cmd/main.go` | register route; wire `UserAdapter` into service |
| `Games-Labs-Order/configs/config.go` | add `USER_HTTP_URL` |
| `Games-Labs-Order/migrations/<next>.sql` | add `price_points` column |
| `api-gateway/gateway/http.go` | add `userOrders.POST("/orders/reward", orderProxy)` |

## Assigned Agent
`dev`

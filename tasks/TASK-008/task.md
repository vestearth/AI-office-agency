# TASK-008: Migrate Missions Store to Read Catalog from Orders

## Overview
Refactor Games-Labs-Missions to stop being the source of truth for package catalog
and exchange rates. Missions should read the catalog from Games-Labs-Order and
delegate all purchase/exchange execution to Orders. Retain mission progression,
pass/avatar inventory, and reward orchestration logic in Missions.

## Type
refactor

## Priority
medium

## Target Service
Games-Labs-Missions

## Target Files
- `Games-Labs-Missions/internal/services/store_service.go`
- `Games-Labs-Missions/cmd/main.go`
- `Games-Labs-Missions/internal/models/models.go`
- `Games-Labs-Missions/internal/repositories/store_repo.go`

## Description
`store_service.go` currently owns the full economy stack: package CRUD, exchange rate
CRUD, purchase execution (wallet credit), exchange execution (wallet debit+credit),
history, idempotency, and in-memory seed data. After TASK-003 through TASK-006,
Orders owns all of this.

### Migration steps:

1. **Add Orders client adapter** to Missions:
   - HTTP or gRPC client that calls Orders' package listing and order creation
   - Interface: `ListPackages(type, active) -> []Package`
   - Interface: `CreateExchangeOrder(userID, packageID, idempotencyKey) -> OrderResult`
   - Interface: `CreatePurchaseOrder(userID, packageID, referenceID) -> OrderResult`

2. **Refactor `store_service.go`**:
   - **Remove**: `PurchasePackage`, `ExchangeDiamonds`, `HandlePaymentWebhook` methods
     (these are now handled by Orders + Wallet)
   - **Remove**: Package/rate CRUD methods (`CreatePackage`, `UpdatePackage`,
     `DeletePackage`, `CreateRate`, `UpdateRate`, `DeleteRate`)
   - **Remove**: In-memory package/rate maps, `seed()` for packages/rates,
     `storeIdempotency` map
   - **Keep**: `ListPackages` and `ListRates` — but refactor to call Orders client
     instead of local DB/memory
   - **Keep**: Pass logic (`BuyPass`, `HasActivePass`, `GrantPass`, `GetPass`,
     `ListPasses`) — stays in Missions for now
   - **Keep**: Avatar logic (`BuyAvatar`, `ListAvatars`, `GetInventory`)
   - **Keep**: `GetHistory` — either call Orders for order history or keep local
     `purchase_history` as a read model

3. **Refactor admin routes** in `main.go`:
   - Remove `/admin/store/packages/*` and `/admin/store/rates/*` routes
     (admin CRUD is now in Orders via TASK-004)
   - Keep `/admin/store/passes/*` and `/admin/store/avatars/*`

4. **Refactor user-facing routes**:
   - `GET /store/packages` → proxy to Orders `GET /api/v1/order-packages?type=purchase`
   - `GET /store/rates` → proxy to Orders `GET /api/v1/order-packages?type=exchange`
   - `POST /store/purchase` → redirect to Orders `POST /api/v1/orders/from-package`
   - `POST /store/exchange` → redirect to Orders `POST /api/v1/orders/exchange`
   - Or: remove these routes entirely and have the client call Orders directly

5. **Feature flag for gradual rollout**:
   - Env var `USE_ORDERS_CATALOG=true/false`
   - When true: Missions reads from Orders
   - When false: Missions uses legacy local store (default during transition)
   - Once stable, remove legacy code path

### Data to keep in Missions:
- `store_passes` table and `user_passes` table (pass catalog and user ownership)
- `user_avatars` table (avatar ownership)
- `purchase_history` as optional read model (Orders is now the source of truth)

### Data to deprecate in Missions:
- `store_packages` table (replaced by `order_packages` in Orders)
- `exchange_rates` table (replaced by `order_packages` type=exchange in Orders)
- `store_idempotency_keys` table (Orders handles idempotency)
- In-memory seed for packages/rates

## Acceptance Criteria
- [ ] Missions has an Orders client adapter that reads package catalog from Orders
- [ ] `PurchasePackage` and `ExchangeDiamonds` are removed from `store_service.go`
- [ ] Package/rate CRUD methods are removed from `store_service.go`
- [ ] `/store/packages` and `/store/rates` user-facing routes proxy to Orders or are removed
- [ ] Admin package/rate routes are removed from Missions
- [ ] Pass and avatar logic remains functional in Missions
- [ ] Feature flag `USE_ORDERS_CATALOG` controls whether to use Orders or legacy store
- [ ] `store_service.go` seed no longer creates package/rate entries
- [ ] No direct Wallet calls for purchase/exchange remain in Missions store logic

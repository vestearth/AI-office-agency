# TASK-EAR-011 — Missions: fix code_name JSON tag + wallet rate key mismatch

## Context

Two silent bugs in Games-Labs-Missions prevent Backoffice exchange presets from
flowing through to the player app correctly when `USE_ORDERS_CATALOG=true`:

**Bug 1 — field name mismatch (code vs code_name)**

`internal/models/models.go` `OrderPackage.Code` carries `json:"code"` but
Order service emits `"code_name"` in its JSON response.  When Missions
decodes the Order list/get response the `Code` field is always empty → falls
back to `pkg.ID` (UUID) in `mapOrderPackageToExchangeRate`.  App receives UUID
as the exchange rate code instead of the human-readable slug (e.g. `"custom"`
or `"ex_25"`).

**Bug 2 — wallet override key uses UUID instead of code_name**

`store_service.go` line 469 builds the Wallet rate key as `"exchange."+snap.ID`
(UUID).  Backoffice syncs to `"exchange.<code_name>"` (e.g. `"exchange.ex_25"`).
These never match, so the Wallet rate-catalog override is dead when Orders
catalog is active.

## Scope

- `Games-Labs-Missions/internal/models/models.go`: change `OrderPackage.Code`
  JSON tag from `"code"` to `"code_name"`.
- `Games-Labs-Missions/internal/services/store_service.go`: build wallet key as
  `"exchange."+snap.Code` with fallback to `snap.ID` when Code is empty
  (preserves in-memory/DB code path).
- `Games-Labs-Missions/internal/services/store_service_test.go`: add
  `TestStoreServiceExchangeWalletKeyUsesCodeNameFromOrderCatalog` confirming the
  key is `"exchange.<code_name>"` not `"exchange.<UUID>"` when Orders catalog is
  active.

## Acceptance

- `go test ./...` passes in Games-Labs-Missions.
- Existing `TestStoreServiceExchangeUsesWalletRateCatalog` (in-memory path) still
  passes unchanged.
- New test proves the Orders-catalog path passes `code_name` to the Wallet key.

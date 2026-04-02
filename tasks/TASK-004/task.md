# TASK-004: Orders Admin APIs for Package Catalog

## Overview
Implement admin HTTP handlers in Games-Labs-Order for full package catalog management,
replacing the empty `adminorderhdl` stub with CRUD, activation, and deactivation
endpoints for both purchase and exchange packages.

## Type
feature

## Priority
high

## Target Service
Games-Labs-Order

## Target Files
- `Games-Labs-Order/internal/core/handlers/adminorderhdl/adminorderhdl.go`
- `Games-Labs-Order/internal/core/handlers/orderhdl/http.go`
- `Games-Labs-Order/cmd/main.go`

## Description
The `adminorderhdl` package exists as an empty stub. The service layer already has
`ListPackages`, `GetPackage`, `UpsertPackage`, `DeletePackage`. Current HTTP routes
expose package CRUD on the main `/api/v1/order-packages` path without admin separation.

This task:

1. **Implement `adminorderhdl`** with dedicated admin handlers:
   - `GET    /admin/packages`        — list all packages (no time-window filter, includes inactive)
   - `GET    /admin/packages/{id}`   — get single package
   - `POST   /admin/packages`        — create package
   - `PUT    /admin/packages/{id}`   — update package
   - `PATCH  /admin/packages/{id}/activate`   — set `active=true`
   - `PATCH  /admin/packages/{id}/deactivate` — set `active=false`
   - `DELETE /admin/packages/{id}`   — soft-delete or hard-delete

2. **Validation rules** (canonical validation lives in `ordersvc.UpsertPackage` from
   TASK-003; admin handlers delegate to service and map errors to HTTP responses):
   - Purchase: `price_amount > 0`, `price_currency` required (default THB),
     `reward_diamonds >= 0`, `reward_coins >= 0`, at least one reward > 0
   - Exchange: `price_diamonds > 0`, `reward_coins > 0`,
     `reward_diamonds` must be 0, `price_amount` must be 0
   - `bonus_percent >= 0`
   - `id` must not conflict with existing package
   - `effective_at < expires_at` when both provided
   - Deactivation should warn if there are pending orders referencing this package

3. **Wire admin routes** in `cmd/main.go`:
   - Mount under `/admin/` prefix
   - Separate from user-facing `/api/v1/order-packages` routes

4. **Refactor existing user-facing routes**:
   - `/api/v1/order-packages` should only list active, time-window-valid packages
   - Remove direct PUT/DELETE from user-facing routes (admin only)

## Acceptance Criteria
- [ ] `adminorderhdl.go` implements list/get/create/update/activate/deactivate/delete handlers
- [ ] Admin list returns all packages including inactive and expired
- [ ] Create validates purchase vs exchange constraints based on `type` field
- [ ] Activate/deactivate endpoints update `active` flag and return updated package
- [ ] User-facing `GET /api/v1/order-packages` only returns active, time-valid packages
- [ ] User-facing routes no longer expose PUT/DELETE (moved to admin)
- [ ] Admin routes are mounted in `main.go` under `/admin/` prefix
- [ ] Invalid requests return structured error responses with field-level detail

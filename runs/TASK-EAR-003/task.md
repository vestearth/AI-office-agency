# TASK-EAR-003: Implement Wallet Admin Rate Catalog gRPC APIs

## Short name
`wallet-admin-rate-catalog-grpc`

## Type
feature

## Priority
high

## Parent / Epic
- Parent: `TASK-EAR-001`
- Epic: Admin Store Exchange Management

## Status
Blocked until `TASK-EAR-002` is published and `Games-Labs-Wallet` bumps
`github.com/SparqLab/shared-lib` to the new version.

## Background

`Games-Labs-Wallet` already has rate catalog repository/service behavior and
direct HTTP handlers:
- `GET /wallets/rate-catalog?domain=exchange`
- `GET /wallets/rate-catalog/by-key?rate_key=exchange.ex_25`
- `POST /admin/wallets/rate-catalog/upsert`
- `POST /admin/wallets/rate-catalog/deactivate`

This task exposes the same production behavior through the new AdminWallet gRPC
contract from `TASK-EAR-002`.

## Scope

### Target services

| Service | Role |
| --- | --- |
| `Games-Labs-Wallet` | Implement AdminWallet rate catalog RPCs and tests. |

### Affected files

| File | Action | Notes |
| --- | --- | --- |
| `Games-Labs-Wallet/go.mod` / `Games-Labs-Wallet/go.sum` | modify | Bump published `shared-lib`; run `go mod tidy`; no local replace. |
| `Games-Labs-Wallet/internal/core/handlers/adminwallethdl/grpc.go` | modify | Add List/Get/Upsert/Deactivate rate catalog methods. |
| `Games-Labs-Wallet/internal/core/services/walletsvc/service.go` | modify only if needed | Reuse existing `ListActiveRates`, `GetActiveRateByKey`, `UpsertRate`, `DeactivateRate`. |
| `Games-Labs-Wallet/internal/repositories/exchange_rate.go` | modify only if needed | Preserve existing persistence/versioning semantics. |
| `Games-Labs-Wallet/internal/core/handlers/adminwallethdl/*_test.go` | create/modify | Add focused gRPC handler coverage. |

## Required behavior

- `ListRateCatalog(domain=exchange)` returns rates from the rate catalog repo.
- `GetRateCatalog(rate_key)` returns one active rate or a structured not-found
  status.
- `UpsertRateCatalog` validates exchange sync fields before saving:
  - `rate_key` required.
  - `domain` required; for Backoffice exchange sync it must support `exchange`.
  - `input_unit`, `output_unit`, `numerator`, `denominator`, and
    `rounding_mode` required.
  - `denominator > 0`.
  - For `domain=exchange`, reject non-`DIAMOND -> COIN` units unless product
    explicitly expands the exchange model.
- `DeactivateRateCatalog(rate_key)` soft-deactivates via existing service logic.
- Use `X-Admin-User`/metadata-derived `updated_by` when request omits it, if the
  shared contract supports it.

## Acceptance criteria

- [ ] Wallet builds against the published `shared-lib` version from `TASK-EAR-002`.
- [ ] AdminWallet gRPC methods are implemented without duplicating local proto/types.
- [ ] Focused tests cover happy path and validation errors for upsert/deactivate.
- [ ] `GOWORK=off go test ./...` passes in `Games-Labs-Wallet`.
- [ ] `GOWORK=off go build -mod=readonly ./...` passes in `Games-Labs-Wallet`.
- [ ] `go.mod` and `go.sum` are committed together after `go mod tidy`.
- [ ] No `replace github.com/SparqLab/shared-lib => ../shared-lib` is committed.
- [ ] `ruby ai-dev-office/validate-yaml.rb TASK-EAR-003` passes.

## Out of scope

- Editing `shared-lib` proto contract.
- Editing api-gateway or Backoffice.
- Changing Wallet rate catalog database schema unless tests prove the current
  schema cannot support the contract.

## Assignment

- Primary: `dev-2`
- Parallel: `false`

Reason: implementation depends on the published shared contract and touches
Wallet handler/service/tests.

## Next action

After `TASK-EAR-002` is published and Wallet bumps `shared-lib`, run:
`./ai-dev-office/run-agent.sh TASK-EAR-003 dev-2`.

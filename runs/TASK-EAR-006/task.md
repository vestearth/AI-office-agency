# TASK-EAR-006: Harden Order Exchange Package Admin Contract

## Short name
`order-exchange-package-hardening`

## Type
feature

## Priority
high

## Parent / Epic
- Parent: `TASK-EAR-001`
- Epic: Admin Store Exchange Management

## Status
Ready for implementation against the existing AdminOrder package contract.

## Background

Backoffice Exchange will use Order admin packages as the authoritative admin
catalog for exchange presets. Existing AdminOrder package CRUD already supports
`PACKAGE_TYPE_EXCHANGE`, but it should be verified and hardened before the UI
depends on it for production sync.

## Scope

### Target services

| Service | Role |
| --- | --- |
| `Games-Labs-Order` | Validate and harden exchange-type package CRUD behavior. |

### Affected files

| File | Action | Notes |
| --- | --- | --- |
| `Games-Labs-Order/internal/core/handlers/adminorderhdl/adminorderhdl.go` | inspect/modify | Ensure admin package CRUD maps exchange fields correctly. |
| `Games-Labs-Order/internal/core/services/ordersvc/service.go` | inspect/modify only if needed | Preserve runtime exchange order behavior and wallet catalog lookup. |
| `Games-Labs-Order/internal/core/repositories/*` | inspect/modify only if needed | Ensure persistence supports exchange package fields. |
| `Games-Labs-Order/tests/**` or handler/service test files | create/modify | Add focused coverage for exchange packages. |
| `Games-Labs-Order/go.mod` / `Games-Labs-Order/go.sum` | modify only if needed | If touched, run tidy and commit both files together; no local replace. |

## Required behavior

- Admin can list exchange packages with `type=PACKAGE_TYPE_EXCHANGE` or the
  accepted equivalent used by existing AdminOrder handlers.
- Admin can create/update/deactivate exchange packages with:
  - `code_name`
  - `name`
  - `price_diamonds`
  - `reward_coins`
  - `image_url`
  - `active`
  - `sort_order`
  - effective window fields where supported
  - metadata where supported
- Validation rejects invalid exchange packages:
  - missing/blank `code_name`
  - non-positive `price_diamonds`
  - non-positive `reward_coins`
  - wrong package type for exchange endpoints/queries
- `code_name` remains stable and compatible with Wallet
  `rate_key = exchange.<code_name>`.
- Runtime exchange order creation remains compatible with existing
  `CreateExchangeOrder` behavior.

## Acceptance criteria

- [ ] Existing AdminOrder exchange package CRUD behavior is confirmed or hardened.
- [ ] Focused tests cover exchange list/create/update/deactivate and invalid diamond/coin values.
- [ ] Existing runtime exchange order tests remain passing.
- [ ] `GOWORK=off go test ./...` passes in `Games-Labs-Order`.
- [ ] `GOWORK=off go build -mod=readonly ./...` passes in `Games-Labs-Order`.
- [ ] If `go.mod` changes, `go mod tidy` is run and `go.mod`/`go.sum` are committed together.
- [ ] No `replace github.com/SparqLab/shared-lib => ../shared-lib` is committed.
- [ ] `ruby ai-dev-office/validate-yaml.rb TASK-EAR-006` passes.

## Out of scope

- Adding a new Order proto field unless a real contract gap is found. If a
  shared contract gap is found, stop and route through `shared-lib` per AGENTS.md.
- Wallet rate catalog implementation.
- Backoffice UI wiring.

## Assignment

- Primary: `dev-2`
- Parallel: `false`

Reason: Order exchange packages are runtime-sensitive and must stay compatible
with exchange order creation.

## Next action

Run `./ai-dev-office/run-agent.sh TASK-EAR-006 dev-2`.

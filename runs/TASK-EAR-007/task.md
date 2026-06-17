# TASK-EAR-007: Review and Smoke Store Exchange Sync Rollout

## Short name
`store-exchange-sync-review`

## Type
feature

## Priority
high

## Parent / Epic
- Parent: `TASK-EAR-001`
- Epic: Admin Store Exchange Management

## Status
Blocked until implementation tasks are complete.

## Background

The Store Exchange sync rollout crosses shared-lib, Wallet, Order, api-gateway,
and Backoffice. It needs an independent reviewer pass that verifies contract
sequencing, dependency bumps, route behavior, and operator smoke through the
gateway.

## Scope

### Target services

| Service | Role |
| --- | --- |
| `shared-lib` | Verify contract is additive, generated, and published/bumped downstream. |
| `Games-Labs-Wallet` | Verify AdminWallet rate catalog implementation and tests. |
| `Games-Labs-Order` | Verify exchange package CRUD hardening and tests. |
| `api-gateway` | Verify admin route exposure, auth/RBAC, docs/Postman. |
| `Games-Labs-backoffice` | Verify real API wiring, partial-sync UX, and browser smoke. |

## Review checklist

- `shared-lib` contract:
  - AdminWallet rate catalog RPCs/messages are additive.
  - Generated artifacts are not manually edited beyond generator output.
- Downstream dependency hygiene:
  - No local `replace github.com/SparqLab/shared-lib => ../shared-lib`.
  - `go.mod` and `go.sum` changes are paired after `go mod tidy`.
  - `GOWORK=off go build -mod=readonly ./...` passes for Go services touched.
- Runtime behavior:
  - Gateway exposes admin Wallet rate catalog routes behind auth/admin middleware.
  - Order exchange package CRUD persists required fields.
  - Backoffice create/update/deactivate writes Order first and Wallet sync second.
  - Partial Wallet sync failure is visible and retryable.
- Smoke:
  - Create exchange preset in Backoffice.
  - Confirm Order package exists as `PACKAGE_TYPE_EXCHANGE`.
  - Confirm Wallet rate exists as `exchange.<code_name>`.
  - Confirm `GET /api/v1/store/rates` reflects the preset.
  - Confirm runtime exchange uses the synced rate or document any environment blocker.

## Acceptance criteria

- [ ] `ruby ai-dev-office/validate-yaml.rb TASK-EAR-001` through `TASK-EAR-007` pass.
- [ ] Reviewer output lists exact commands run and results.
- [ ] Reviewer output lists any skipped smoke checks with concrete environment reason.
- [ ] No high/critical findings remain open.
- [ ] `TASK-EAR-007` status moves to `done` only after review and smoke evidence are attached.

## Assignment

- Primary: `reviewer`
- Parallel: `false`

Reason: final cross-service verification should be independent from implementation.

## Next action

After `TASK-EAR-003`, `TASK-EAR-004`, `TASK-EAR-005`, and `TASK-EAR-006` are
complete, run `./ai-dev-office/run-agent.sh TASK-EAR-007 reviewer`.

# TASK-EAR-001: Production-Grade Admin Store Exchange Sync

## Short name
`admin-store-exchange-sync`

## Type
feature

## Priority
high

## Parent / Epic
- Parent: none
- Epic: Admin Store Exchange Management

## Status
Umbrella planning task. Child tasks are opened and ordered by dependency.

## Background

The Backoffice page `/admin/manage/store/exchange` is currently local/mock state
only. It needs to manage exchange presets as real admin data and keep runtime
exchange behavior consistent across Order, Wallet, Missions, and api-gateway.

Production-grade sync means:
- Backoffice must use api-gateway admin APIs, not direct service internals.
- Exchange presets must be managed as Order packages with
  `PACKAGE_TYPE_EXCHANGE`.
- Wallet rate catalog must be updated through an AdminWallet gRPC contract in
  `shared-lib`, not a direct HTTP shortcut.
- Runtime store exchange must continue to resolve through existing Missions and
  Order/Wallet paths.

## Child tasks

| Task | Title | Owner | Dependency |
| --- | --- | --- | --- |
| `TASK-EAR-002` | Add AdminWallet rate catalog contract to shared-lib | `dev-2` | none |
| `TASK-EAR-003` | Implement Wallet AdminWallet rate catalog gRPC APIs | `dev-2` | `TASK-EAR-002` published and bumped in Wallet |
| `TASK-EAR-004` | Expose AdminWallet rate catalog through api-gateway | `dev` | `TASK-EAR-002` published and bumped in api-gateway |
| `TASK-EAR-005` | Wire Backoffice Store Exchange to Order + Wallet sync | `dev-2` | `TASK-EAR-003`, `TASK-EAR-004`, `TASK-EAR-006` complete/deployed |
| `TASK-EAR-006` | Harden Order exchange package admin contract | `dev-2` | existing AdminOrder contract; `TASK-EAR-002` only if a shared-lib gap is discovered |
| `TASK-EAR-007` | Review and smoke Store Exchange sync rollout | `reviewer` | `TASK-EAR-003`-`TASK-EAR-006` complete |

## Target services

| Service | Role |
| --- | --- |
| `shared-lib` | Owns new AdminWallet proto contract and generated artifacts. |
| `Games-Labs-Wallet` | Implements admin rate catalog RPCs using existing rate catalog service/repository. |
| `api-gateway` | Exposes new AdminWallet HTTP mappings through grpc-gateway. |
| `Games-Labs-backoffice` | Replaces mock exchange page state with real Order package CRUD plus Wallet sync. |
| `Games-Labs-Order` | Existing AdminOrder package CRUD is the admin source for exchange presets; no new contract expected. |
| `Games-Labs-Missions` | Runtime consumer of store rates/exchange; no code change expected unless smoke finds drift. |

## Acceptance criteria

- [ ] `TASK-EAR-002` defines a shared AdminWallet rate catalog API with generated artifacts.
- [ ] `TASK-EAR-003` implements and tests Wallet admin rate catalog behavior.
- [ ] `TASK-EAR-004` exposes and documents the new admin gateway paths.
- [ ] `TASK-EAR-006` confirms/hardens Order exchange package CRUD for Backoffice Exchange.
- [ ] `TASK-EAR-005` replaces mock Backoffice exchange data with real list/create/update/deactivate plus sync handling.
- [ ] `TASK-EAR-007` independently verifies contract bumps, builds/tests, route auth, and operator smoke.
- [ ] End-to-end smoke demonstrates: create exchange preset in Backoffice, Wallet rate exists as `exchange.<code_name>`, `GET /api/v1/store/rates` reflects the preset, and runtime exchange uses the synced rate.
- [ ] No consumer service commits a local `replace github.com/SparqLab/shared-lib => ../shared-lib`.
- [ ] `ruby ai-dev-office/validate-yaml.rb TASK-EAR-001` passes.

## Coordination notes

- `TASK-EAR-002` is the first hard dependency. Per AGENTS.md, downstream service
  work that needs the new contract must wait until the user publishes and bumps
  `shared-lib`.
- `TASK-EAR-003`, `TASK-EAR-004`, and `TASK-EAR-006` can proceed in parallel
  after their dependencies are clear.
- `TASK-EAR-005` should start only after the gateway path and Order exchange
  package behavior are available in the target environment.
- `TASK-EAR-007` is the final review/smoke gate.

## Assignment

- Primary: `dev-2`
- Parallel: `false`

Reason: this is an umbrella coordination task with cross-service sequencing and
contract ownership.

## Next action

Run `./ai-dev-office/run-agent.sh TASK-EAR-002 dev-2` to implement the upstream
shared-lib contract first.

# TASK-EAR-108: Implement Order catalog lookup and legacy aliases

Parent `TASK-EAR-100`; blocked by published `TASK-EAR-107`. Epic: Store Items canonical catalog rollout. Feature/backend/high; owner `dev-2`.

## Outcome

Make Order the complete runtime catalog provider for Pass and Avatar items. Implement the published non-admin list/get contract, resolve canonical UUIDs and approved legacy Missions IDs through an Order-owned alias table, and backfill aliases deterministically. Do not expose AdminOrder or permit direct Order DB access from Missions.

## Scope

- Order special-item model, repository/service ports, service and WebOrder handler/tests.
- New `special_item_aliases` migration and migration runner registration.
- Published shared-lib bump in `Games-Labs-Order/go.mod` and `go.sum`.

## Acceptance criteria

- Complete active catalog list/get responses contain all published purchase-validation fields.
- Lookup accepts canonical UUID or an approved legacy alias and returns one canonical UUID; unknown/ambiguous aliases fail safely.
- Alias rows have uniqueness/referential integrity and deterministic, reviewable backfill evidence for existing Missions Pass/Avatar IDs.
- Sale-window/status filtering and lookup semantics share one server-side implementation and focused repository/service/handler tests pass.
- `go mod tidy`, focused tests, `GOWORK=off go build -mod=readonly ./...` and `git diff --check` pass with no `replace`.

## Dependencies and rollout

Start only after the TASK-EAR-107 shared-lib version is published. This task may run in parallel with TASK-EAR-109 because they own separate repos. Deploy and smoke the Order provider before TASK-EAR-110 starts.

Published TASK-EAR-107 dependency: `github.com/SparqLab/shared-lib@v0.0.0-20260713083006-64c2276be266` (PR 16 merge commit `64c2276be26640d20f0ab94532bb88031cd98099`).

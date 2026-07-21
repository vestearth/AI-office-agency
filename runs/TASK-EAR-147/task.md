# TASK-EAR-147: Game classification epic — Phase 1: game_category table + admin API + assignment

## Type

feature

## Workstream

backend

## Priority

high

## Created

2026-07-18

## Epic

Canonical game-classification — Phase 1 of 5. Depends on TASK-EAR-146
(canonical set). Unblocks 148 (event emit) and 150 (backoffice).

## Goal

Make the canonical `game_category` taxonomy the admin-managed source of truth
in Games-Labs-Game, and enforce that every active game is assigned to one.

## Scope (Games-Labs-Game, + shared-lib proto for the admin API)

1. `game_categories` table: `code` (unique, stable UPPER_SNAKE), display
   name, `active`, `sort_order`, timestamps.
2. Admin CRUD RPC + api-gateway route (add the proto `google.api.http`
   binding — Missions-style mux-only routes die at the gateway) + a
   list/distinct endpoint the Backoffice dropdown hydrates from.
3. `games.game_category_code` column referencing the taxonomy (validated
   against the table; not free text).
4. Migration seeding game assignments from the TASK-EAR-146 mapping.
5. Write-path validation: `CreateGame` / `UpdateGame` reject an unknown or
   empty `game_category` for active games.

## Ordering (critical)

Seed-assign all active games (step 4) BEFORE enabling the write-guard
(step 5) — otherwise editing any legacy game without an assignment is blocked.

## Acceptance

- Taxonomy table + admin CRUD live through the gateway (authenticated round
  trip 200/401, not 404).
- Every active game has a valid `game_category_code`.
- `CreateGame`/`UpdateGame` reject invalid/empty category; accept valid.
- List endpoint returns the active taxonomy for Backoffice.
- `go build` + `go test ./...` green. PR targets staging.

## Admin-managed, no deploy to add a type

Adding a new game type = inserting a `game_categories` row via admin, not a
code change (decided 2026-07-18, source-of-truth = DB table).

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
in Games-Labs-Game, formalizing the **existing** `games.category` column
rather than adding a new one (TASK-EAR-146 staging audit found `category`
already deterministic per game, not messy free text — see 146 findings).

## Scope (Games-Labs-Game, + shared-lib proto for the admin API)

1. `game_categories` lookup table: `code` (PK, stable UPPER_SNAKE), display
   name, `active`, `sort_order`, timestamps. Seed exactly the 5 canonical
   rows from TASK-EAR-146: `SLOTS, CRASH, ARCADE, MINIGAME, CARD`.
2. **Pre-flight safety check (do this first):** run
   `SELECT DISTINCT category FROM games` on staging (re-verify) and on prod
   (146 only audited staging). If any value falls outside the 5 seeded codes,
   add a matching `game_categories` row for it before the next step — do not
   silently drop or rewrite an existing game's category. Flag anything
   unexpected back to the run instead of guessing.
3. Add a **foreign key on the existing `games.category` column** referencing
   `game_categories(code)` — no new column, no data migration/backfill (values
   already match per the 146 audit; step 2 exists only to catch the prod gap).
4. Admin CRUD RPC for `game_categories` (create/update/deactivate) +
   api-gateway route (add the proto `google.api.http` binding — Missions-style
   mux-only routes die at the gateway), plus a list endpoint (active rows)
   the Backoffice dropdown hydrates from.
5. `CreateGame` / `UpdateGame` already get FK-level rejection of an unknown
   category; add a friendly application-level error message instead of
   surfacing the raw constraint violation.

## Acceptance

- FK constraint applies cleanly on staging and prod (step 2 catches any gap
  first — no failed migration, no orphaned category values).
- Taxonomy table + admin CRUD live through the gateway (authenticated round
  trip 200/401, not 404).
- `CreateGame`/`UpdateGame` reject invalid/empty category with a clear error;
  accept any of the 5 valid codes.
- List endpoint returns the active taxonomy (5 rows) for Backoffice.
- `go build` + `go test ./...` green. PR targets staging.

## Admin-managed, no deploy to add a type

Adding a new game type = inserting a `game_categories` row via admin, not a
code change (decided 2026-07-18, source-of-truth = DB table).

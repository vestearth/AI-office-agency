# TASK-EAR-148: Game classification epic — Phase 2: emit game_category on events (additive)

## Type

feature

## Workstream

backend

## Priority

high

## Created

2026-07-18

## Epic

Canonical game-classification — Phase 2 of 5. Depends on TASK-EAR-147 (games
assigned). Unblocks 149 (Missions consume).

## Goal

Carry the assigned `game_category` on gameplay activity events, additively,
without disturbing the existing `game_type` field.

## Scope (shared-lib + Games-Labs-Game)

1. shared-lib `events/player_activity.go`: add
   `GameCategory string \`json:"game_category,omitempty"\`` to
   `PlayerActivityEvent`. Additive + `omitempty` — schema stays `v1`,
   existing consumers ignore it (backward compatible).
2. Games-Labs-Game: resolve the game's assigned `game_category` at settle
   (same place `game_type` is resolved from the game row) and populate it on
   `turnover.settled` / `round.settled` and their reversals.

## Acceptance

- `turnover.settled` and `round.settled` carry `game_category` for assigned
  games; reversals carry it too.
- Events for games without an assignment omit the field (fail-open; the
  legacy fuzzy fallback in Missions covers them — see 149).
- Old consumers unaffected (no schema break); `go test ./...` green.
- PR targets staging.

## Note

`game_category` and the existing `game_type` now coexist on the event. Keep
`game_type` untouched (still the per-game mechanic); `game_category` is the new
canonical scoping dimension. Document both in the event field dictionary.

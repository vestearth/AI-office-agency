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
2. Games-Labs-Game: resolve `game_category` at settle from the same game row
   already used to resolve `game_type` — it's `strings.TrimSpace(game.Category)`
   (the FK-enforced column from TASK-EAR-147, not a new lookup/join) — and
   populate it on `turnover.settled` / `round.settled` and their reversals.

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

## Execution plan (coordinator, 2026-07-21) — 2 sequenced stages

Recon on the current `staging` branch (post-147 merges, pin
`v0.0.0-20260721072957-2be4d9337474`) found `game_type` threads through FOUR
files before reaching the event, not two — `GameCategory` needs the same
chain, added alongside each existing `GameType` field (never replacing it):

1. `internal/models/game.go`: `RoundLifecycle` struct (line ~88) has
   `GameType string` — add `GameCategory string` next to it.
2. `internal/core/services/gamesvc/service.go`:
   - `settledRoundLifecycle` (~line 517) sets
     `GameType: strings.TrimSpace(game.GameType)` on the built
     `RoundLifecycle` — add `GameCategory: strings.TrimSpace(game.Category)`
     (the FK-enforced column from TASK-EAR-147; not a new lookup).
   - `roundActivityInputFromLifecycle` (~line 582) and
     `turnoverActivityInputFromLifecycle` (~line 605) both copy
     `lifecycle.GameType` into their respective Input structs — thread
     `lifecycle.GameCategory` through the same way.
3. `internal/core/services/gamesvc/player_activity.go`:
   - `RoundActivityInput` (line ~16-23) and `TurnoverActivityInput`
     (~line 103-112) both have `GameType string` — add `GameCategory string`
     to both.
   - `buildRoundActivityEvent` (~line 50-74, sets fields ~line 67) and
     `buildTurnoverActivityEvent` (~line 161-196, sets fields ~line 189)
     both do `GameType: strings.TrimSpace(in.GameType)` when building the
     `events.PlayerActivityEvent` — add
     `GameCategory: strings.TrimSpace(in.GameCategory)` to both.
   - `validateRoundActivityInput` requires non-empty `GameType`. Do **not**
     add the same requirement for `GameCategory` — task's fail-open
     acceptance criterion: a game with no assigned category (nullable
     column) still settles normally, just omits the field on the event.

**Stage A — shared-lib, dispatched first, standalone PR to `main`:**
- `events/player_activity.go`: add
  `GameCategory string \`json:"game_category,omitempty"\`` to
  `PlayerActivityEvent`, next to the existing `GameType` field. No codegen
  needed (plain Go struct, not protobuf). `go build ./...`, commit, push,
  PR to `main`. Stop — do not touch Games-Labs-Game.

**Stage B — Games-Labs-Game, after Stage A merges:**
- `go get github.com/SparqLab/shared-lib@<merged-commit> && go mod tidy`.
- Apply the 4-file chain above.
- `go build ./...` + `go test ./...`, commit, push, PR to `staging`.

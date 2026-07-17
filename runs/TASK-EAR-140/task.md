# TASK-EAR-140: Missions — Category Turnover never counts (game_type vocab mismatch)

## Type

bug

## Workstream

backend

## Priority

high

## Created

2026-07-18

## Goal

QA (2026-07-18): Category Turnover progress stays 0/target on staging, both
Daily and Weekly, while `any_game_turnover` and `spend_prop` on the same
weekly card list count normally.

Root cause (confirmed against staging data): the mission-config vocabulary
and the games-catalog vocabulary for game type are disjoint, and the runtime
matcher compares them exactly.

- Config side: Backoffice dropdown `Slot/Card/Crash/Arcade/Mini Game` is
  stored as `SLOT/CARD/CRASH/ARCADE/MINIGAME`
  (`missionCategoryToApiGameType`, mirrored by Missions
  `categoryToGameType` for generator-built plans).
- Event side: `turnover.settled` carries `games.game_type` verbatim.
  Staging distinct values: `HEIST MINES SLOTS CROSSING MONOPOLY CRASH
  PLINKO MINIGAME BOUNCY` (game-mechanic names, ops-entered; no code path
  writes this column and no shared enum exists anywhere).
- Matcher (`activity_match.go`) uses exact `strings.EqualFold`, fail-closed:
  `SLOT` vs `SLOTS` never matches, so every category_turnover rule scoped to
  Slot accrues nothing. `CRASH`/`MINIGAME` coincidentally match, which is why
  the bug surfaces per-category rather than globally.
- The Backoffice preview ("All games in Slot are included (N games)") counts
  by `games.category` with fuzzy contains (`gameMatchesMissionCategory`), so
  the config UI looks correct while runtime matches a different column with a
  stricter rule.

## Fix (this task)

Align the runtime game-type matching semantics with what the config UI
already promises: normalized fuzzy match instead of exact EqualFold, in
`Games-Labs-Missions/internal/services/activity_match.go`:

- Normalize both sides with the existing `normalizeCategoryKey` (lowercase,
  strip space/underscore/hyphen — already mirrors the Backoffice
  `normalizeGameCategoryKey`).
- Match when equal or when either normalized key contains the other
  (identical semantics to Backoffice `gameMatchesMissionCategory`).
- Keep fail-closed: empty rule game_type or empty event game_type never
  matches.
- Apply to all three game-type comparisons in the shared matcher:
  `TURNOVER_GAME_TYPE`, `ROUND_COUNT_GAME_TYPE`, and the
  `TURNOVER_GAME_POOL` PoolGameTypes loop (same defect class; one shared
  matcher covers Daily + Weekly).
- Update/extend the matcher tests that lock these semantics (SLOT vs SLOTS
  matches, MINI GAME vs MINIGAME matches, unrelated types don't, empty
  stays fail-closed).

Game-id scoping (`TURNOVER_GAME`, pool game ids) stays exact — UUIDs share
one ID space and are not affected.

## Out of scope (follow-up candidates)

- Backoffice guard: `Card`/`Arcade` dropdown options match zero games in the
  catalog; preview should count/warn from `games.game_type` (the column the
  runtime actually uses) instead of `games.category`.
- `ListWeeklyMissions` returns raw DB names, so Mobile shows slugs like
  `category_turnover`; the display-name resolver is applied only in quest
  overview + daily groups.
- Canonical game-type enum shared across Game/Provider/Missions/Backoffice.

## Acceptance

- Matcher unit tests cover the new semantics and pass (`go test ./...`).
- A `turnover.settled` event with `game_type=SLOTS` accrues progress on a
  rule configured as `SLOT` (daily + weekly paths share the matcher).
- Behavior for already-matching tokens (`CRASH`, `MINIGAME`) unchanged.
- PR targets `staging` (QA env) per current deploy topology.

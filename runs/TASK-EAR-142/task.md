# TASK-EAR-142: Missions — weekly cards show raw slugs instead of display names

## Type

bug

## Workstream

backend

## Priority

medium

## Created

2026-07-18

## Goal

Follow-up from TASK-EAR-140 (spotted on the QA weekly screenshot). Mobile's
weekly mission cards show raw DB names — `category_turnover`,
`any_game_turnover`, `spend_prop` — because `ListWeeklyMissions`
(`Games-Labs-Missions/internal/services/weekly_service.go`) builds cards from
`definition.Name` verbatim. The display-name templating
(`mission_display_name.go`, e.g. `category_turnover` → "Play by {Category}
Game") is applied only in the quest-overview path
(`quest_overview_service.go`) and daily groups
(`mission_service_daily_groups.go`), never on the weekly list.

Generator-built weekly activities store the template slug as `name`, so any
schedule-generated weekly plan ships slugs straight to Mobile.

## Fix (this task)

Apply the existing display-name resolver on the weekly list path:

1. In the weekly card build (`buildWeeklyMissionCard` call site in
   `ListWeeklyMissions`), resolve a display name via the same
   template-key/value mechanism the quest overview uses
   (`missionTemplateKeyForConditionType` + `resolveMissionDisplayName`),
   falling back to the stored name for non-template rows (manually named
   activities must keep their names).
2. Fill template values from the activity row (category from `game_type`,
   total games from pool size, threshold/diamonds where the template needs
   them) — mirror what the quest overview already does rather than inventing
   new formatting.
3. Cover with a unit test: generator-slug-named weekly activity renders the
   template name; manually named activity passes through unchanged.

## Non-goals

- No proto/contract change — `name` stays the same field, only its value is
  resolved server-side.
- Daily/overview paths unchanged (already resolve names).

## Acceptance

- Weekly card list for a generator-built plan shows human names ("Play by
  Slot Game", "Play Any Game", ...) instead of slugs; manually named rows
  unchanged.
- `go test ./...` green.
- PR targets Missions `staging` per current deploy topology.

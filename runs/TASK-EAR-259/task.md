# TASK-EAR-259: Expose Weekly game_turnover Pool Game IDs to the Player API

## Type

Enhancement / API contract

## Workstream

Backend

## Priority

Medium — QA explicitly reported this as not urgent.

## Goal

Let mobile render the Weekly "Play X Games" sub-page by returning the pooled
game ids on the weekly mission card and the quest-overview weekly item, WITHOUT
changing how the mission completes.

## Product Decision (recorded before scoping)

Weekly `game_turnover` keeps its current semantics: **one pooled mission,
"reach the turnover in any of the N games"** — it is NOT expanded into N
per-game child missions the way Daily is.

Operator's reasoning (chat, 2026-08-14): showing the game list makes the card
attractive and gives the player an entry point, while a single 1,000-turnover
target stays achievable in one week. Expanding to N x 1,000 would make the
mission roughly seven times harder than what staging serves today.

Rejected alternative — Daily parity (`kind: "group"` + `children`) — would need
per-game progress rows, a migration, and a reward-semantics decision. Not in
this task.

## Confirmed Current Behaviour (read 2026-08-14, Games-Labs-Missions @ ec84072)

- The weekly generator writes **one** `WeeklyActivity` whose games live in
  `Pool` — `internal/services/schedule_generator.go:375-390` (condition
  `TURNOVER_GAME_POOL`). Daily instead expands one activity per game
  (`schedule_generator.go:272-290`), which is why only Daily can emit
  `kind: "group"`.
- Matching is aggregate: turnover on ANY pooled game credits the single counter
  — `internal/services/activity_match.go:96-118`.
- `target` is `MinTurnoverPerGame` used as the whole mission's threshold —
  `internal/services/schedule_defaults.go:274-278`. So the QA payload's
  `target: 1000` is per-game config applied pool-wide, and the label
  "Play 7 Games" comes from pool size (`weekly_service.go:555-558`).
- `WeeklyMissionCard` carries no game data (`internal/models/models.go:418`),
  and the overview weekly tab is a flat map over `resp.Missions` that never
  sets `Kind`/`Children` (`internal/services/quest_overview_service.go:448-486`).
- Both routes return `google.protobuf.Struct`
  (`shared-lib/proto/missionspb/missions.proto:41,69`), so new JSON fields reach
  mobile with **no proto, gateway, or shared-lib change**. Prove it at the edge
  anyway — do not assume.

## Scope

| Repository | Files / responsibility |
| --- | --- |
| `Games-Labs-Missions` | Repository batch read of weekly pool entries; hydrate the pool onto the weekly card; pass it through the quest-overview weekly item; tests. |
| — | No migration. No schema change. No shared-lib / proto / api-gateway / backoffice change. |

### Contract to add (snake_case, additive, omitempty)

On each weekly mission card (`GET /api/v1/missions/weekly` → `missions[]`) and
on the matching quest-overview weekly item
(`GET /api/v1/quest/overview` → `tabs[key=weekly].items[]`), for
`TURNOVER_GAME_POOL` missions only:

- `game_ids: string[]` — pool entries with `entry_type = "game"`, in
  `sort_order`, exactly the games the plan configured.
- `game_categories: string[]` — pool entries with `entry_type = "category"`,
  same ordering rule. Present because the pool model allows category entries
  (`models/weekly_config.go:41-47`); omit when empty.

Mobile resolves names and images from the game catalog it already uses for the
lobby. Missions does NOT call the Game service for this — see "Out of Scope".

## Acceptance Criteria

- Both endpoints return `game_ids` for a schedule-generated weekly
  `game_turnover` mission, listing exactly the plan's pooled games in
  `sort_order`.
- Weekly items still have **no** `kind: "group"` and **no** `children` — assert
  this explicitly so a future reader cannot mistake the shape for Daily's.
- `progress`, `target`, `claimable`, `claimed` and the completion-bonus counts
  are byte-identical to today's for the same fixture. A regression test proves
  turnover on ONE pooled game still completes the mission at 1,000.
- A weekly `spend_prop` mission does not leak its `special_item` pool entry
  through either new field.
- With no active weekly plan (hardcoded fallback definitions), both endpoints
  return no `game_ids` and do not error.
- A pool read failure degrades to an absent/empty list and never fails the
  request — this list is display-only, unlike the progress numbers.
- No N+1: pool hydration for a week's activities is one batch query, asserted
  by test (sqlmock expectation count), not by inspection.
- Verified on staging by grepping the RAW response body through the gateway
  edge for both routes — not through the Missions mux, and not from a green
  build.

## Ordered Plan

1. Write the failing tests first: weekly card + overview shape, ordering,
   fallback-plan case, spend_prop non-leak, semantics-unchanged regression.
   Record them seen RED.
2. Repository: add a batch "pool entries for these activity ids" read
   (`ListWeeklyActivityPoolEntries` is per-activity today —
   `internal/repositories/mission_repo.go`), returning entries grouped by
   activity id in `sort_order`.
3. `weekly_service.go`: hydrate the pool in `ListWeeklyMissions`, emit the
   fields only for `TURNOVER_GAME_POOL`, tolerate a read error by leaving the
   lists empty.
4. `quest_overview_service.go` `buildWeeklyTab`: carry the same fields onto the
   overview item.
5. Run the focused Missions suite; confirm the previously red tests pass.
6. Deploy to the Missions staging lane and verify both raw bodies through the
   gateway with the devtest QA player.
7. Reply to QA/mobile with the field names and the explicit rendering
   constraint (see below).

## Mobile Rendering Constraint (must be stated in the handoff)

- One aggregate progress bar only: total turnover `0/1000`. There is **no**
  per-game progress.
- The game rows are launch entry points ("Go"). There is **no** per-row
  Done/checkmark state.
- The mock QA attached (Achievement 2/3, per-row 1000/1000) is the **Daily**
  design; Weekly will not look like that.

## Out of Scope

- Renaming the mission label. "Play 7 Games" is resolved at read time from the
  Setting Default → Mission → Weekly `Mission Name` template
  (`weekly_service.go:549` → `mission_display_name.go:56-83`), and because the
  generator stores the raw slug `game_turnover` as the activity name, editing
  that template retitles already-generated weekly plans immediately. That is a
  Backoffice content change with no code and no deploy, and it should happen
  regardless of this task so the title stops implying all N games are required.
- Enriching the pool with game names / images inside Missions. Rejected: it
  puts a per-request cross-service `ListGame` call on a hot public endpoint,
  and would need caching plus wiring `gameCatalog` into `WeeklyService` (only
  `MissionService` has it today — `mission_service.go:77,123`).
- Daily-parity child expansion (`kind: "group"`), per-game weekly progress, and
  any change to weekly reward or claim semantics.

## Risks

- Mobile builds per-game progress UI anyway because the field list resembles
  Daily's. Mitigated only by the handoff note above being explicit.
- Mid-week active-plan swap changes the pool a player already saw; the read
  path is already scoped to the active plan for the week
  (`mission_repo.go:2640-2660`) so the list simply follows the swap. Call it
  out rather than special-casing it.

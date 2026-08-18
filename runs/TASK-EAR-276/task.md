# TASK-EAR-276: Align Weekly Play X Games with Per-Game Progress

- Short name: `weekly-play-games-per-game-progress`
- Epic: Weekly Missions mobile parity
- Type: feature
- Workstream: backend
- Priority: medium
- Created: 2026-08-18
- Target cutover: Bangkok week starting 2026-08-24
- Implementation status: planned; not implemented

## Goal

Change schedule-generated Weekly `game_turnover` / “Play X Games” from one
pooled turnover counter into one parent mission whose selected games each have
an independent 1,000-turnover requirement. Mobile must see completed-games
progress on the parent and per-game turnover progress in display/launch-only
children. Reward and claim remain a single parent action.

## Approved product contract

- Every selected game must independently reach the configured
  `minTurnoverPerGame` (currently 1,000).
- Parent progress is `completed games / total games`, for example `2/7`, with
  unit `children`.
- Each child exposes its game id and `current turnover / 1,000`, with unit
  `amount`, plus enough completion state for Mobile to render it.
- Children are display/progress/launch rows only. They have no reward and no
  claim action. The parent keeps the one reward, `Collect`, claim idempotency,
  and claim endpoint.
- The new rule starts only for `week_start >= 2026-08-24` in Bangkok time.
  Earlier weeks keep the existing pooled semantics.

The supplied screenshots support the single parent reward/Collect and Go-only
child interaction. Their `50/1000` header is evidence of the old pooled UI, not
the target parent progress; the target header is completed games over total
games.

## Current source evidence

- Weekly defaults generate one `TURNOVER_GAME_POOL` activity with selected game
  ids in its pool (`internal/services/schedule_defaults.go`,
  `internal/services/schedule_generator.go`).
- The shared matcher credits turnover from any pooled game into one activity
  delta (`internal/services/activity_match.go`).
- `weekly_activity_progress` is keyed by user/activity/week, and
  `weekly_activity_event_applications` is keyed by event/activity without a
  game id (`migrations/031_weekly_activity_progress.sql`). Existing pooled
  history therefore cannot be losslessly split into per-game history.
- Weekly claimability is derived from `WeeklyMissionCard.Progress >= Target`,
  and Quest Overview maps the same flat card without children
  (`internal/services/weekly_service.go`,
  `internal/services/quest_overview_service.go`).
- Both public RPCs return `google.protobuf.Struct`, so an additive JSON contract
  does not require a shared-lib proto or generated gateway change. The gateway
  edge must still be verified after deployment.

## Scope

### Target repository

- `Games-Labs-Missions` only: owns Weekly plan progress, RabbitMQ event
  application/reversal, mission claimability, both public response builders,
  migrations, and focused tests.

### Expected affected files

- `migrations/*_weekly_game_progress.sql` (create): persist per-game weekly
  progress and the event/application data required for idempotent reversal.
- `internal/repositories/mission_repo.go`: read/write/reverse per-game progress
  while preserving existing activity-level paths for other Weekly conditions.
- `internal/services/weekly_match.go`: carry the matched concrete game id into
  Weekly pool progress deltas after the cutover.
- `internal/services/weekly_service.go`: aggregate child completion into parent
  progress and claimability, while keeping one reward and claim identity.
- `internal/models/models.go`: additive Weekly parent/child response types and
  explicit progress units.
- `internal/services/quest_overview_service.go`: emit a Weekly group item with
  parent `children` progress and no child reward/claim action.
- `internal/repositories/weekly_progress_test.go`,
  `internal/services/weekly_service_test.go`,
  `internal/services/weekly_pool_game_ids_test.go`, and
  `internal/services/quest_overview_service_test.go`: red-first regression and
  contract coverage.
- `README.md`: document the new Weekly player contract and cutover boundary.

### Explicitly out of scope

- No separate child rewards, child claim endpoint, or child wallet credits.
- No change to Game event schema, Wallet credit contract, Weekly reward amount,
  or parent claim idempotency key.
- No shared-lib/proto/generated gateway change unless implementation discovery
  disproves the current `Struct` passthrough.
- No Backoffice redesign and no change to Daily missions.
- No attempt to infer or backfill per-game progress for weeks before the
  cutover from the existing aggregate rows.
- `TURNOVER_GAME_POOL` activities using category or mixed pool entries and
  hardcoded fallback Weekly definitions retain their current behavior unless a
  separate product decision explicitly brings them into scope. The new parity
  rule targets schedule-generated pools of concrete game ids.

## Acceptance criteria

1. For a schedule-generated Weekly game pool on or after 2026-08-24, 1,000
   turnover on game A completes only game A; it does not complete any sibling
   and does not unlock the parent.
2. Additional turnover above 1,000 on the same game remains capped for display
   and cannot substitute for an incomplete sibling.
3. The parent becomes claimable only when every selected game independently
   reaches 1,000; it remains one mission with one reward and one idempotent
   parent claim.
4. `GET /api/v1/missions/weekly` returns, for the target mission, parent
   completed/total progress plus ordered children containing `game_id`,
   per-game current/target amount progress, and completion state.
5. `GET /api/v1/quest/overview` returns the same Weekly parent as
   `kind: "group"`, with `progress.current = completed games`,
   `progress.target = total games`, `progress.unit = "children"`, and ordered
   per-game children whose progress unit is `amount`.
6. Weekly children expose no reward, `claimable`, `claimed`, or child claim
   route; Mobile continues to use each row only for display and launch (`Go`).
7. Duplicate forward delivery does not double-count a child. A valid reverse
   subtracts from the original game, can move that child below 1,000, and
   recomputes parent completion before claim.
8. Weekly completion-bonus counts and parent claim authorization use the new
   completed-games result for the target mission.
9. `week_start < 2026-08-24`, non-game Weekly conditions, category/mixed pooled
   activities, and no-active-plan fallback behavior remain covered and
   unchanged.
10. The migration applies cleanly to an existing schema and has a reviewed
    rollback/disable strategy. No historical aggregate row is presented as
    per-game progress.
11. Focused repository/service/handler tests are seen red before implementation
    and green after; full `GOWORK=off go test ./...`, `go vet ./...`, build with
    `-mod=readonly`, and `git diff --check` pass.
12. After merge to `staging` and a successful Missions deployment, authenticated
    raw responses through the API Gateway prove both endpoint shapes. Controlled
    non-promotional settled rounds prove one game cannot complete siblings and
    all games complete the parent. Production remains unverified until a
    separate production rollout.

## Technical plan

1. Add red-first contract and behavior tests, including pre-cutover and sibling
   conditions.
2. Add additive per-game progress/application persistence. Keep the existing
   activity-level tables for other Weekly mission types; do not destructively
   rewrite historical rows.
3. Extend the Weekly event delta/application path with concrete game identity,
   preserving per-event idempotency, active-plan scoping, promotional exclusion,
   and reverse behavior.
4. Read ordered pool entries and per-game progress, then build one parent card
   with capped children and completed/total aggregation.
5. Reuse that result in Quest Overview and gate claimability plus Weekly
   completion-bonus counting on all children complete.
6. Apply the Bangkok week-start cutover so deployment before Monday cannot alter
   the active 2026-08-17 week.
7. Document, verify locally, review the migration, merge to `staging`, deploy,
   and perform authenticated gateway acceptance.

## Risks and mitigations

- Historical progress cannot be split per game: cut over at 2026-08-24 and do
  not backfill aggregate rows.
- Semantic compatibility for older Mobile clients: keep JSON changes additive
  where possible, coordinate the parent progress meaning/unit, and verify both
  endpoints using raw gateway bodies before Mobile release.
- Reverse/idempotency defects can corrupt completion: persist game identity in
  the application ledger and cover duplicate, reverse, and reverse-after-cap
  cases.
- Reward multiplication: keep one parent mission/claim record and assert one
  Wallet credit regardless of child count.
- Deploying early could change the current week: gate by Bangkok `week_start`,
  not wall-clock deployment time.
- Existing category/mixed pools do not map to a finite child game list: preserve
  them under legacy aggregate semantics and test that compatibility row.

## Assignment

- Primary: `dev-2`
- Parallel: no
- Reason: one repository, but schema, event idempotency/reversal, public API
  semantics, rewards, migration, and cutover share files and must be implemented
  sequentially.

## Blockers

None. Product confirmed the per-game threshold, one-parent-claim model, and
2026-08-24 Bangkok cutover.

## Next action

`dev-2` branches from the current `origin/staging`, records the focused tests
red, implements the additive persistence and response contract, and hands off
to Reviewer. The PR target is `staging`.

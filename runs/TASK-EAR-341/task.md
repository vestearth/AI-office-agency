# TASK-EAR-341: Scope the Daily player-activity matcher to the event day's active plan

## Type
bug (hygiene / performance) — not a money defect

## Priority
medium

## Scope
### Target Services
- `Games-Labs-Missions` only (`internal/repositories/mission_repo.go`,
  `internal/services/mission_service.go`, tests)

### Explicitly Out Of Scope
- Deactivating or deleting historical `daily_activities` rows
- Backfilling or deleting existing dead `daily_activity_progress` rows
- Weekly matcher (already plan-scoped via `ListActiveWeeklyActivityRules(ctx, weekStart)`)
- Backoffice, gateway, shared-lib, the Android client repo

## Problem
`ListActiveDailyActivityRules` selects every `daily_activities` row with
`active = TRUE AND condition_type IS NOT NULL`, with no join to
`daily_activity_group_members` / `daily_activity_groups` / `daily_plans`.
`HandlePlayerActivityEvent` applies every accepted event to all of them.
Staging evidence (EAR-301 closeout, 2026-09-09): one synthetic turnover event
for devtest wrote 168 `daily_activity_progress` rows while the Bangkok-day plan
held 2 rules and Monitoring showed 2 rows.

Player-facing reads (`ListDailyActivityProgress`) and Collect are scoped to the
current day's plan and to `bangkok_day = event day`, so the extra rows are never
read or paid. The defect is wasted writes and table growth.

## Decision (operator, 2026-09-09)
Scope the matcher to the rules on the active plan of the **event's** Bangkok
day. Do not touch rule lifecycle.

## Acceptance criteria
- [x] `ListActiveDailyActivityRules` takes the Bangkok day and applies the same
      `EXISTS (members -> active group -> active plan with plan_date = day)`
      predicate `ListDailyActivityProgress` uses
- [x] The day is derived from `evt.OccurredAt` (same derivation as the
      `daily_activity_progress.bangkok_day` key), never from wall-clock now
- [x] Focused test seen RED first: one event, three active rules (current-plan,
      other-day plan, orphaned/no plan) → progress only on the current-plan rule,
      `mission.progressed` published only for it
- [x] Reverse events still reverse what forward applied (test, not inspection)
- [x] EAR-301 loop-guard tests unchanged and green; full `GOWORK=off go test ./...`,
      vet, `go build -mod=readonly`, `git diff --check` clean
- [x] Staging smoke after deploy: fresh event → progress-row count == rules on
      that day's plan (currently 2), not 168; Monitoring Daily still renders
      current/target/status
- [x] TASK-EAR-213 orphan-row note corrected per the librarian patch

## Rollback
Revert the PR; no migration expected. If a migration is added it must be
idempotent (Missions replays all migrations on boot).

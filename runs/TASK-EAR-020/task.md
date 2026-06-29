# TASK-EAR-020: Weekly Option B — B1 schema + models (parallel weekly_* tables)

## Short name
`weekly-b1-schema-models`

## Parent / Epic
- Parent: `TASK-EAR-018` (Weekly Option B). Implements phase **B1** of
  `weekly-option-b-design.md`. Reuses G2 (`evaluateConditionMatch`) + G1 decisions.

## Lane
Claude advisory lane (dev role).

## Scope (this slice)
Schema + Go config models for the weekly cadence on PARALLEL `weekly_*` tables
(daily schema untouched). Pools deferred to B5; repos + read-path rewire deferred.

## Delivered
- Migrations (auto-picked by `//go:embed *.sql`, idempotent):
  - `027_create_weekly_activities.sql` — mirrors daily_activities; column names
    aligned with daily so the G2 matcher + models reuse. `condition_type` accepts
    turnover/spend/round families AND legacy meta counters (daily_mission|watch_ad|
    mission_boost).
  - `028_create_weekly_activity_groups.sql` — groups (+ `_members`, one group per
    activity), plan-level total reward.
  - `029_create_weekly_plans.sql` — the SCHEDULING layer daily lacks: binds a group
    to a Bangkok-Monday `week_start`; status derived, not stored; range query =
    last4/thisWeek/next4 board.
  - `030_weekly_completion_bonus.sql` — `mission_config.weekly_completion_bonus_*`
    + per-(user, week_start) claim ledger (mirrors daily 021).
- Models: `internal/models/weekly_config.go` — `WeeklyActivity`,
  `WeeklyActivityGroup` (+`Member`), `WeeklyPlan` + `WeeklyPlanStatus` +
  pure `DeriveWeeklyPlanStatus(planWeekStart, currentWeekStart)`.
- Test: `internal/models/weekly_config_test.go` — status derivation incl. cross-year.

## G4 reconciliation (behaviour-neutral seed)
The 3 current weekly missions are meta counters; their replacement plan is week-
dated, and a pure-SQL seed CANNOT compute "this Monday". Behaviour-neutrality is
therefore provided by the EXISTING read-path fallback to
`defaultWeeklyMissionDefinitions` (`weekly_service.go:49`) while the new tables
start EMPTY — mobile keeps seeing the same 3 missions until an admin creates a
weekly plan. No dated SQL seed is shipped in B1. (Full G4 closure is asserted in
B6 when the read path reads plans-or-fallback.)

## Verification
- `GOWORK=off go build ./...` → exit 0
- `GOWORK=off go vet ./internal/...` → exit 0
- `GOWORK=off go test ./...` → exit 0 (no regressions; daily/weekly suites green)
- `TestDeriveWeeklyPlanStatus` green incl. cross-year edge.

## Deferred (next slices)
- Repos (list/get/upsert/update/delete + members + plan range query) + tests.
- B2 weekly progress mapper reusing `evaluateConditionMatch` over the week window
  + the meta-counter dispatch (daily_mission/watch_ad/mission_boost via mission_logs).
- B5 pools (`activity_pools` + entries + selection ledger) — gated by G1 (now clear).
- B6 read-path rewrite (G3 payload) + G4 neutrality assertion.

## Notes
condition_type is a free VARCHAR covering both condition families; the evaluator
dispatch (turnover/spend/round via matcher vs meta-counters via mission_logs) is a
B2 concern, not a schema concern.

## Review closeout

Reviewer pass completed on 2026-06-29 against current `main`.

- Source reviewed: migrations `027-030` and `internal/models/weekly_config.go`
  plus `internal/models/weekly_config_test.go`.
- Verdict: approved; no blocking findings.
- Verification: `GOWORK=off go test ./...`, `go vet ./internal/...`, and
  `GOWORK=off go build -mod=readonly ./...` passed in `Games-Labs-Missions`.

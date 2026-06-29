# TASK-EAR-021: Weekly Option B — B2 weekly progress mapper (matcher reuse)

## Parent / Epic
- Parent: `TASK-EAR-018`. Phase **B2** of `weekly-option-b-design.md`.
- Depends on G2 (`evaluateConditionMatch`, TASK-EAR-019) + B1 (TASK-EAR-020).
- Branch: `feat/weekly-b2-progress-mapper` (integration = G2 + B1 + this).

## Delivered (slice 1 — pure mapper)
- `internal/services/weekly_match.go` — `mapPlayerActivityEventToWeeklyProgress(evt,
  rules)` reuses the shared `evaluateConditionMatch`; differs from the daily mapper
  ONLY in the stamped bucket (Bangkok week start via `weeklyMissionWindow` vs Bangkok
  day). Legacy meta counters are not event-mapped (matcher returns false).
- `internal/repositories/mission_repo.go` — added `WeeklyActivityProgressDelta`
  (mirrors `DailyActivityProgressDelta`, bucketed by `WeekStart`).
- `internal/services/weekly_match_test.go` — week bucketing, meta-counter exclusion,
  and daily/weekly match-set agreement.

## Verification
- `go build ./...` / `go vet ./internal/...` / `go test ./...` → all exit 0.
- Existing weekly service tests unchanged and green.

## DESIGN DECISION pending (gates the next slice)
Weekly progress STORAGE: (a) event-source into a new `weekly_activity_progress`
table (mirror daily `ApplyDailyActivityForward`/`daily_activity_progress` — efficient
reads, idempotent forward/reverse) vs (b) compute on-the-fly by counting within the
week window (like the current weekly meta counters via `CountMissionLogsInRange` —
no new table, heavier reads). B1 did NOT add a weekly progress table. Recommend (a)
for turnover/spend/round families (volume), keep (b) for meta counters.

## Deferred (next slices)
- The storage decision above + `weekly_activity_progress` migration + repo
  forward/reverse + consumer hookup (PlayerActivityConsumer also drives weekly).
- Meta-counter read aggregation (daily_mission/watch_ad/mission_boost) for weekly.
- B6 read-path rewrite to the G3 payload.

## Review closeout

Reviewer pass completed on 2026-06-29 against current `main`.

- Source reviewed: `internal/services/weekly_match.go`,
  `internal/repositories/mission_repo.go`, `migrations/031_weekly_activity_progress.sql`,
  and the weekly mapper/progress tests.
- Verdict: approved for B2 slice 1/2a; the documented reverse-before-forward
  reconciliation remains a deferred follow-up and is not a blocker for this slice.
- Verification: `GOWORK=off go test ./...`, `go vet ./internal/...`, and
  `GOWORK=off go build -mod=readonly ./...` passed in `Games-Labs-Missions`.

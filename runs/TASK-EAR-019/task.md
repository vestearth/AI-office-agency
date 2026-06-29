# TASK-EAR-019: Extract pure daily condition matcher (gate G2)

## Short name
`missions-evaluator-extraction-g2`

## Type
refactor

## Parent / Epic
- Parent: `TASK-EAR-018` (Weekly Option B); clears gate **G2** in
  `runs/TASK-EAR-018/gates.md`, per `runs/TASK-EAR-018/g2-evaluator-extraction-plan.md`.
- Epic: Backoffice Mission management / Weekly Option B (B2 prerequisite).

## Lane
Claude manual advisory lane (dev role); machine-readable agent fields use enum roles.

## Goal
Make the daily-activity progress matcher reusable by the future weekly cadence
WITHOUT changing daily behaviour or touching daily persistence/windowing.

## What changed
- NEW `internal/services/activity_match.go` — `evaluateConditionMatch(rule, evt)
  (delta float64, matched bool)`: pure, cadence-agnostic condition matcher for all
  7 types (TURNOVER_AMOUNT/_GAME/_GAME_TYPE, SPEND_AMOUNT, SPEND_DIAMOND_AMOUNT,
  ROUND_COUNT_GAME/_GAME_TYPE). No time/day/window/timezone awareness.
- EDIT `internal/services/mission_service.go` — `mapPlayerActivityEventToDailyProgress`
  delegates to the matcher and only stamps `bangkokDay` (−70/+9).
- NEW `internal/services/activity_match_test.go` — characterization test (7 types +
  edges), direct matcher unit test, and a time-independence test proving weekly reuse.

## Out of scope (deliberately, minimal-change)
No migrations, no `bangkok_day` column/struct rename, no repo signature changes,
no weekly wiring. Those belong to B1/B4/B6 with parallel weekly_* tables.

## Verification (evidence)
- `GOWORK=off go build ./...` → exit 0
- `GOWORK=off go vet ./internal/services/` → clean
- `GOWORK=off go test ./...` → exit 0, all packages ok
- Pre-existing `TestMapPlayerActivityEventToDailyProgress_ScopedTurnoverRules`
  unchanged and green ⇒ behaviour-neutral.

## Gate G2 exit criteria — met
- [x] Characterization tests green BEFORE extraction.
- [x] All daily/consumer/group/bonus tests green after extraction (byte-identical).
- [x] `evaluateConditionMatch` has zero time/day/window references (pure; proven).
- [x] Weekly reuse demonstrated at matcher level without touching daily persistence.
- [x] No DB rename / no cross-site bangkok_day parameterization.

## Next
B2 proper (weekly progress mapper + persistence on parallel weekly_* tables) can
now reuse `evaluateConditionMatch`. Still gated by G1 (Game catalog) / G3 (payload)
for the broader weekly epic.

## Review closeout

Reviewer pass completed on 2026-06-29 against current `main`.

- Source reviewed: `internal/services/activity_match.go`,
  `internal/services/mission_service.go`, and `internal/services/activity_match_test.go`.
- Verdict: approved; no blocking findings.
- Verification: `GOWORK=off go test ./...`, `go vet ./internal/...`, and
  `GOWORK=off go build -mod=readonly ./...` passed in `Games-Labs-Missions`.

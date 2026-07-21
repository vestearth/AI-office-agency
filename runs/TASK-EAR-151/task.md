# TASK-EAR-151: Game classification epic — Phase 5: retire fuzzy fallback (metric-gated)

## Type

chore

## Workstream

backend

## Priority

low

## Created

2026-07-18

## Epic

Canonical game-classification — Phase 5 of 5. Depends on TASK-EAR-149
(deployed) + a retention-window wait. Closes the epic.

## Goal

Once every game-scoped mission scores on `game_category` and no event/config
still needs the legacy path, remove the fuzzy fallback so matching is pure
exact.

## Gate (do not start until all true)

- TASK-EAR-149 deployed to staging (and prod, per rollout).
- Mission-config migration complete (no `game_type`-only game-scoped rules).
- `applied_forward_legacy_fuzzy` count == 0 over the agreed retention window
  (query `daily_activity_consumer_events`).

## Scope (Games-Labs-Missions)

1. Remove the `game_type` normalize+contains fallback from
   `activity_match.go`; matcher becomes exact on `game_category` only.
2. Remove the temporary `applied_forward_legacy_fuzzy` status handling.
3. Confirm no regression: all configs migrated, matcher tests updated to
   exact-only.

## Acceptance

- Fallback removed; matcher exact-only on `game_category`.
- Metric confirmed 0 before removal (evidence attached to the run).
- `go test ./...` green. PR targets staging.

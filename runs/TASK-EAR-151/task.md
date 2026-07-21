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
- **⚠️ Known gap found during TASK-EAR-149 (2026-07-21), do NOT gate on the
  metric above alone:** `daily_activity_consumer_events` is a **daily-only**
  ledger. Weekly missions use a deliberately simpler 2-table event-source
  (`weekly_activity_progress` / `weekly_activity_event_applications`, from
  TASK-EAR-021, predates this epic) with **no status/observability column at
  all** — `ViaFallback` is computed for weekly deltas but has nowhere to
  persist, so weekly's fuzzy-fallback usage is **structurally invisible** to
  this metric. A `daily_activity_consumer_events` count of 0 proves nothing
  about weekly missions still relying on the fallback (e.g. any weekly
  activity or pool entry not yet migrated, or created after TASK-EAR-149 but
  before TASK-EAR-150's Backoffice write path ships `game_category`).
  Before removing the fallback, either: (a) add a weekly equivalent
  observability column/ledger first (small follow-up, mirrors the daily
  pattern) and gate on both metrics being zero, or (b) directly verify
  weekly config completeness by query (`SELECT * FROM weekly_activities
  WHERE condition_type IN ('TURNOVER_GAME_TYPE','ROUND_COUNT_GAME_TYPE') AND
  (game_category IS NULL OR game_category = '')` and the equivalent for
  `weekly_activity_pool_entries` category rows) instead of trusting an
  event-based metric that can't see weekly at all. Do not skip this — it is
  the difference between "provably safe to remove" and "probably fine."

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

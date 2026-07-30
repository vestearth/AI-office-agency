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

## Gate (all must hold; do not start until verified)

**Replaced 2026-07-29 by TASK-EAR-168.** The previous gate was unsatisfiable:
it counted `daily_activity_consumer_events` over all history with no time
predicate, so once a single fuzzy row existed it could never return to zero —
and 20 already did, all predating any possible fix. Full reasoning and the
exact queries: `runs/TASK-EAR-168/gate-definition.md`.

- **A. Rule invariant (blocking).** No `active` category-scoped rule has an
  empty `game_category`, and no category pool entry holds a non-canonical
  `entry_ref`, across `daily_activities`, `weekly_activities`,
  `daily_activity_pool_entries`, `weekly_activity_pool_entries`. Queries in
  §A. Two traps: `active` is excluded for A1 only (the loader is
  `WHERE active = TRUE`, `mission_repo.go:2301-2306`), and
  `weekly_activities.game_category` is `NOT NULL DEFAULT ''` while daily's is
  nullable — a NULL-only check on weekly returns nothing and falsely reads
  clean.
- **B. Producer invariant (blocking).** No active game has an empty
  `games.category` (Games-Labs-Game DB). §B. This side was missed by every
  earlier version of this gate: the fallback fires when **either** side's
  category is empty, and the event's value comes from `games.category`, which
  is nullable and whose FK explicitly does not close NULL.
- **C. Time-bounded metric (corroborating, not sufficient alone).**
  `applied_forward_legacy_fuzzy = 0` for events created **after** the deploy
  that satisfied A and B. Never query lifetime totals. §C.
- **D. Traffic floor (validity precondition for C).** ≥300 events in C's
  window — derived in §D from the observed 1.1% historical fuzzy share. Below
  that, C is **NOT EVALUATED**, not passed. Staging runs ~2 events/day, so the
  gate is not evaluable there without generated load.

**A and B are the actual proof.** Together they make the fallback branch in
`activity_match.go:52-57` unreachable by construction, since it requires
`(rule.GameCategory == "" || evt.GameCategory == "")`. C and D are regression
detection, not evidence of safety.

**Weekly is covered by A, not by C — deliberately.** The weekly event source
has no status column by design (migration 031; `mission_repo.go:2731-2737`
notes `ViaFallback` is computed with nowhere to persist), and TASK-EAR-168
decided **not** to add one: A already covers both cadences, and a weekly
ledger would be a schema plus live-scoring-write-path change to buy an
observation the invariant makes redundant. This is a stated limitation — after
retirement, a weekly regression is caught by re-running A, not by a metric.

### Standing against this gate (2026-07-29)

| condition | status |
| --- | --- |
| A1 rules | staging clear (TASK-EAR-166/170); **prod unverified** — TASK-EAR-170 audit pending |
| A2 pools | ❌ **FAILS** — 16 `entry_ref='FISHING'` rows, TASK-EAR-167 |
| B producer | measured 0 on 2026-07-29; re-check at gate time (column is nullable) |
| C metric | cannot evaluate until A and B hold and a cutoff exists |
| D traffic | staging ~2 events/day, far below the 300 floor |

**Blocked on TASK-EAR-167 (A2) and the TASK-EAR-170 prod audit (A1).**

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

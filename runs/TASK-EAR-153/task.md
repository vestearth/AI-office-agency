# TASK-EAR-153: Migrate daily_activity_pool_entries to canonical game_category

## Type

bugfix

## Workstream

backend

## Priority

high

## Created

2026-07-22

## Epic

Canonical game-classification — follow-up to TASK-EAR-149 (Phase 3), found
during the TASK-EAR-151 (Phase 5) gate check. Closing this is what actually
unblocks 151.

## Goal

TASK-EAR-149 migrated `weekly_activity_pool_entries` category tokens to
canonical `game_category` codes but explicitly deferred
`daily_activity_pool_entries` as a documented, "low real-world likelihood"
gap. The TASK-EAR-151 gate check (2026-07-22, staging) disproved that
assessment: `daily_activity_pool_entries` has real, active category-pool
entries still holding the legacy token `SLOT` on schedule-generator-created
activity IDs (e.g. `da-2026-06-23-cat`, `daily-seed-2026-07-01-...`), and the
daily fallback-usage metric (`daily_activity_consumer_events`) shows
`applied_forward_legacy_fuzzy = 5` — almost certainly these exact rows
scoring via the fuzzy fallback instead of an exact `game_category` match.

## Scope (Games-Labs-Missions)

Mirror TASK-EAR-149 Stage A's migration for `weekly_activity_pool_entries`
(migration `047_game_category_migration.sql`) — same pattern, same care,
targeting `daily_activity_pool_entries` instead:

1. New migration file (check `ls migrations/*.sql | sort -V | tail -3` for
   the actual current latest at execution time).
2. Migrate `daily_activity_pool_entries` rows where `entry_type = 'category'`
   using the TASK-EAR-146 locked mapping: `SLOT -> SLOTS`, `CRASH -> CRASH`,
   `ARCADE -> ARCADE`, `MINIGAME -> MINIGAME`, `CARD -> CARD`. Any
   `entry_ref` that doesn't match one of these five (case-insensitive) is
   left unmigrated — correct, fail-safe behavior, not a bug (mirrors
   TASK-EAR-151's FISHING finding on the weekly table: some dead/legacy
   references may not map to anything real, and inventing a mapping would
   be wrong).
3. **`(activity_id, entry_type, entry_ref)` is this table's composite
   PRIMARY KEY too** (same shape as `weekly_activity_pool_entries`, see
   `036_daily_activity_pools.sql`) — a naive `UPDATE ... SET entry_ref = ...`
   can collide if an activity's pool already has both a legacy token and its
   canonical equivalent as separate rows. Use the same three-step pattern
   TASK-EAR-149 Stage A proved out and tested against a real Postgres
   (`INSERT ... ON CONFLICT (activity_id, entry_type, entry_ref) DO NOTHING`,
   then `DELETE` legacy rows that now have a canonical sibling, then
   `UPDATE` any remaining legacy row with no sibling). Read
   `047_game_category_migration.sql` directly for the exact, already-tested
   SQL shape to mirror — including the identity-mapping self-collision fix
   (`entry_ref <> '<canonical>'` on every step, so a row already holding the
   canonical value doesn't match its own DELETE-EXISTS check and get wiped).

## CRITICAL — idempotency (confirmed fact, not a maybe)

`migrations/run.go`'s `Run()` (called from `cmd/main.go` with `log.Fatalf` on
error) re-executes every `.sql` file in this directory on every single
service boot — no version-tracking table. Every statement in the new
migration must be safe to run more than once, exactly like
`047_game_category_migration.sql` already is. Getting this wrong crashes
every future boot of this service (this exact failure mode hit
Games-Labs-Game during TASK-EAR-147/148 and had to be fixed live — see that
epic's history for the incident).

## Acceptance

- Migration is idempotent (verify by reasoning through each statement, and
  ideally by actually running it twice against a local/throwaway Postgres —
  TASK-EAR-149 Stage A did this and it caught a real bug).
- `go build ./...` + `go test ./...` green.
- PR targets `staging`.
- After merge + deploy, re-run the TASK-EAR-151 gate check: confirm
  `daily_activity_consumer_events` stops accumulating new
  `applied_forward_legacy_fuzzy` rows (existing historical rows don't need
  cleanup — the gate cares about the rate going forward, not backfilling
  history) and `daily_activity_pool_entries` has no more unmigrated
  canonical-mappable tokens.

## Out of scope

- The `weekly_activity_pool_entries` FISHING dead-reference finding from the
  same gate check — that's a data-quality issue (a pool entry pointing at a
  game category with zero games in the catalog, pre-dating this epic), not a
  migration gap. Tracked separately, not part of this task.
- Re-tightening the matcher back to exact-only (that's TASK-EAR-151 itself,
  gated on this task plus the retention-window check).

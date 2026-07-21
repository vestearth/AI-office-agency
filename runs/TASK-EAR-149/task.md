# TASK-EAR-149: Game classification epic — Phase 3: Missions consume game_category, exact matcher + fuzzy fallback

## Type

feature

## Workstream

backend

## Priority

high

## Created

2026-07-18

## Epic

Canonical game-classification — Phase 3 of 5. Depends on TASK-EAR-146
(mapping) and TASK-EAR-148 (events carry game_category). Unblocks 150
(backoffice) and 151 (retire fallback).

## Goal

Score game-scoped missions on the canonical `game_category` with exact
matching, keeping a temporary, observable fuzzy fallback for legacy
config/events until migration is proven complete.

## Scope (Games-Labs-Missions, + shared-lib bump to the 148 version)

1. Add a `game_category` scope field to daily/weekly activity rules; hydrate
   it in `ListActiveDailyActivityRules` / `ListActiveWeeklyActivityRules`;
   expose it in the admin API for the Backoffice editor.
2. Migrate existing `daily_activities` / `weekly_activities` `game_type`
   values to `game_category.code` using the TASK-EAR-146 legacy mapping:
   `SLOT -> SLOTS`, `CRASH -> CRASH`, `ARCADE -> ARCADE`,
   `MINIGAME -> MINIGAME`, `CARD -> CARD` (CARD config rows, if any, keep
   scoring nothing until a CARD game exists — correct fail-closed behavior,
   not a bug).
3. Matcher (`activity_match.go`): **primary** = exact match
   `event.game_category` == `rule.game_category`; **fallback** = the existing
   normalize+contains on `game_type` ONLY when `game_category` is absent on
   either side (legacy events/config).
4. Record a distinct consumer-event status (e.g.
   `applied_forward_legacy_fuzzy`) whenever the fallback path scores, so the
   fallback rate is SQL-queryable off `daily_activity_consumer_events`
   (no prometheus needed — reuse the existing status enum).

## Acceptance

- A `game_category`-scoped rule scores a settled event carrying the matching
  `game_category` exactly (daily + weekly share the matcher).
- A legacy `game_type`-only config still scores via the fallback, and the
  legacy status is recorded on the consumer-event row.
- Migration maps every existing config; unmapped tokens (flagged by 146) fall
  through to fallback, not to zero.
- `go build` + `go test ./...` green (extend matcher tests for both paths).
  PR targets staging.

## Execution plan (coordinator, 2026-07-21, revised same day after a stall)

Recon on the current `staging` branch (pulled to head first; shared-lib pin
currently `v0.0.0-20260717152311-c244e471902d`, needs bumping to the
TASK-EAR-148 merged commit `239418a4b2f5d616af38aea455f908106e643bba` to pick
up `events.PlayerActivityEvent.GameCategory`). No cross-repo merge gate —
Missions is the only repo touched, shared-lib's side is already merged.

**Split into 2 sequenced stages, dispatched separately, after a single-dispatch
attempt stalled 600s during part-5 exploration having only bumped go.mod (no
branch created, no code written).** Splitting reduces per-dispatch scope so
each stage is independently small enough to finish and independently
verifiable — Stage A in particular is the highest-blast-radius piece
(migration; see the idempotency requirement below) and deserves isolated,
careful verification before Stage B builds on it.

**Stage A — schema + migration only, dispatched first, standalone PR to
`staging`:** part 1 below. Small, focused, verifiable in isolation
(read the migration file, confirm idempotency guards, `go build` — no Go
logic changes yet, just the two `ALTER TABLE ADD COLUMN` + backfill/pool
migration SQL). Bump the shared-lib pin in this stage too (needed by Stage B
regardless, and it's a 1-line change with no risk of conflicting with
Stage B's own edits since Stage B doesn't touch go.mod again).

**Stage B — repository + matcher + status tracking + admin API, dispatched
after Stage A merges:** parts 2-5 below, all Go code, no further schema
changes (reads the columns Stage A already added).

### 1. Migration `047_...sql` (check 046 is still latest at execution time)

- `ALTER TABLE daily_activities ADD COLUMN IF NOT EXISTS game_category VARCHAR(100);`
  (mirrors `game_type`'s declaration in `014_add_daily_activity_consumer_state.sql`).
- `ALTER TABLE weekly_activities ADD COLUMN IF NOT EXISTS game_category VARCHAR(100) NOT NULL DEFAULT '';`
  (mirrors `game_type`'s declaration in `027_create_weekly_activities.sql`).
- Backfill `game_category` on BOTH tables for existing
  `TURNOVER_GAME_TYPE`/`ROUND_COUNT_GAME_TYPE` rows using the TASK-EAR-146
  legacy mapping: `SLOT -> SLOTS`, `CRASH -> CRASH`, `ARCADE -> ARCADE`,
  `MINIGAME -> MINIGAME`, `CARD -> CARD` (case-insensitive match on the
  stored `game_type`, since Backoffice writes it uppercased already but
  don't assume). Rows whose `game_type` doesn't match any of these five
  (if any — 146 flagged this as possible) are left with `game_category`
  empty/unmigrated; they keep scoring via the fuzzy fallback, which is
  correct, not a bug — do not invent a mapping for them.
- Migrate `weekly_activity_pool_entries` rows where `entry_type = 'category'`:
  `entry_ref` currently holds the same legacy `game_type` vocabulary. Map it
  to the canonical code using the same table above, **in place is NOT safe**
  — `(activity_id, entry_type, entry_ref)` is the primary key, so if an
  activity's pool already has both a legacy token and its canonical
  equivalent as separate rows (e.g. `SLOT` and `SLOTS`), a naive
  `UPDATE ... SET entry_ref = ...` collides. Do the migration as
  `INSERT INTO weekly_activity_pool_entries (activity_id, entry_type,
  entry_ref, sort_order, weight) SELECT activity_id, entry_type,
  <mapped_value>, sort_order, weight FROM weekly_activity_pool_entries WHERE
  entry_type='category' AND entry_ref IN (...legacy tokens...) ON CONFLICT
  (activity_id, entry_type, entry_ref) DO NOTHING`, then `DELETE` the old
  legacy-token rows that have a canonical sibling; leave any legacy-token
  row with no canonical sibling as an UPDATE instead (safe, no collision).
  **CONFIRMED (not a maybe): `migrations/run.go`'s `Run()` re-executes every
  `.sql` file in this directory unconditionally on every single service
  boot** — same defect class as Games-Labs-Game (TASK-EAR-147/148), just via
  `//go:embed *.sql` auto-scan instead of a hand-maintained list. There is
  leftover debug instrumentation in that file (hypothesis IDs H0-H4,
  targeting `008_migrate_exchange_rates_to_numeric_id.sql`'s failure state)
  from a past investigation into exactly this failure mode — do not touch
  or clean up that instrumentation, it's out of scope, just treat it as
  corroborating evidence this bug class is real and has bitten this repo
  before. **047 MUST be fully idempotent or it will crash every boot after
  the first, exactly like Game's PR #12/#14 incident:**
  - New columns: `ADD COLUMN IF NOT EXISTS` (already specified above).
  - Backfill UPDATEs: guard the WHERE clause so a second run matches zero
    rows, e.g. `UPDATE daily_activities SET game_category = 'SLOTS' WHERE
    game_type ILIKE 'SLOT' AND (game_category IS NULL OR game_category =
    '')` — note `AND` binds tighter than `OR` in SQL, so the `OR` side
    MUST be parenthesized like this or the clause silently matches every
    row regardless of `game_type`. Once `game_category` is populated,
    re-running finds nothing left to update.
  - Pool-entry migration: the `INSERT ... ON CONFLICT (activity_id,
    entry_type, entry_ref) DO NOTHING` is naturally idempotent as
    specified. The `DELETE` of old legacy-token rows that now have a
    canonical sibling is naturally idempotent (deleting an already-deleted
    row matches zero rows). The `UPDATE` fallback for legacy tokens with no
    canonical sibling must target only the OLD token values in its WHERE
    clause (as specified) so a second run finds nothing left to rename.
  - Read a couple of existing migration files for this repo's own
    idempotent-style conventions before writing 047 (e.g. search for
    `IF NOT EXISTS` / `WHERE ... IS NULL` guard patterns already used here).

--- Stage B starts here (after Stage A's migration PR merges) ---

### 2. Repository (`internal/repositories/mission_repo.go`)

- `DailyActivityRule` struct (~line 69): add `GameCategory string` field.
- `ListActiveDailyActivityRules` (~line 2246) and `ListActiveWeeklyActivityRules`
  (~line 2595): both `SELECT`/`Scan` `game_type` today — add
  `COALESCE(game_category, '')` / `COALESCE(a.game_category, '')`
  respectively and scan into `rule.GameCategory`.
- The `TURNOVER_GAME_POOL` pool hydration loop in
  `ListActiveWeeklyActivityRules` reads `entry_type='category'` rows into
  `rule.PoolGameTypes` — after the migration above, these values are
  canonical codes where migrated, still-legacy tokens where not. No
  structural change needed here (`PoolGameTypes` stays one list); the
  matcher (below) is what changes how it's compared.

### 3. Matcher (`internal/services/activity_match.go`)

- Change `evaluateConditionMatch`'s signature to return a third value:
  `(delta float64, matched bool, viaFallback bool)`. `viaFallback` is true
  only when a match happened through the fuzzy `gameTypeMatches` path
  instead of an exact `game_category` comparison; false for every other
  condition type (amount, spend, exact game-id, etc.) and false when an
  exact `game_category` match succeeded.
- `TURNOVER_GAME_TYPE` / `ROUND_COUNT_GAME_TYPE`: primary path — if
  `rule.GameCategory != "" && evt.GameCategory != "" &&
  strings.EqualFold(rule.GameCategory, evt.GameCategory)`, match with
  `viaFallback=false`. Fallback path — only when either side's
  `GameCategory` is empty, fall through to the existing
  `gameTypeMatches(rule.GameType, evt.GameType)` check, `viaFallback=true`
  if it matches.
- `TURNOVER_GAME_POOL`: for the category-pool loop, try
  `evt.GameCategory != "" && strings.EqualFold(entry, evt.GameCategory)`
  first per pool entry (`viaFallback=false`); if that loop finds nothing,
  fall back to the existing `gameTypeMatches(entry, evt.GameType)` loop
  (`viaFallback=true`). Game-id pool matching (exact `PoolGameIDs`)
  is untouched — always `viaFallback=false`.
- This function is covered by a characterization test comment claiming its
  behavior is "locked byte-for-byte" — that lock is about existing
  (delta, matched) outcomes for existing inputs, not the function
  signature. Adding a third return value and updating every call site
  (including in the test file) is expected and required; do not treat the
  comment as forbidding this change, but DO make sure every existing test
  case's (delta, matched) pair is unchanged before adding new
  fallback-specific cases.

### 4. Threading `viaFallback` to a recorded status

- `repositories.DailyActivityProgressDelta` (~line 85): add
  `ViaFallback bool` field.
- `mapPlayerActivityEventToDailyProgress` (`internal/services/mission_service.go`
  ~line 2255) and its weekly counterpart (find it in `weekly_match.go` —
  comments there say it reuses `evaluateConditionMatch`): capture the third
  return value and set it on the `DailyActivityProgressDelta` they build.
- Add `DailyActivityEventStatusAppliedForwardLegacyFuzzy
  DailyActivityEventStatus = "applied_forward_legacy_fuzzy"` next to the
  existing status constants (`internal/repositories/mission_repo.go` ~line 56-66).
- `ApplyDailyActivityForward` (~line 2310) currently picks
  `DailyActivityEventStatusAppliedForward` when `len(deltas) > 0`. Change
  to: if `len(deltas) > 0` AND any delta has `ViaFallback == true`, use the
  new `AppliedForwardLegacyFuzzy` status instead of plain `AppliedForward`.
  Find and mirror the same change in whatever function applies weekly
  deltas forward (likely `ApplyWeeklyActivityForward` in the same file,
  described in a nearby comment block as event-id-guarded idempotent
  weekly apply — read it to confirm the exact status-selection line).

### 5. Admin API (optional field, groundwork for TASK-EAR-150)

- Daily activity create/update (`internal/services/mission_service.go`,
  the validation block around line ~1951-2032 that reads/validates
  `act.GameType`) and weekly's equivalent (`internal/services/weekly_admin.go`
  ~line 90-172): add an optional `GameCategory` field alongside `GameType`
  on the request struct, persisted as-is (no allowlist/validation against a
  fixed set — mirrors the pool-entries comment "opaque, trust the
  Backoffice picker, no Missions->Game client"). Do NOT make it required
  and do NOT change any existing `GameType`-based validation — this is
  purely additive so TASK-EAR-150's Backoffice work has a field to write
  to; the admin API's read paths (list/get) should return it too.

## Notes

- Keep `game_type` fully untouched everywhere (still read/validated/scored
  exactly as today) — `game_category` is additive throughout, matching the
  event-side precedent from TASK-EAR-148.
- `CARD` config rows (if any exist) legitimately fall through to fallback
  forever until a CARD game exists in Game's catalog — expected, not a bug.

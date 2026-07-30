# TASK-EAR-170 — Durable migration for plural-SLOTS rows + prod exposure check

## Type

bugfix

## Workstream

backend

## Priority

high

## Created

2026-07-29

## Epic

Canonical game-classification (TASK-EAR-140..153). Follow-up to TASK-EAR-166,
which stays **done** — its code fix and the staging data correction both
landed. This task closes the one gap that fix could not: every other
environment.

## Context

TASK-EAR-166 stopped the generator from ever producing a category rule with an
empty `game_category`, and the operator corrected the 3 affected staging rows
by hand (`daily-real-2026-07-09-t2` → `SLOTS/SLOTS`; two `GAMEUUIDAAA` seed
rows deactivated, not deleted). Evidence:
`runs/TASK-EAR-166/handoff-data-correction.md`.

**That correction covered staging only, and nothing will fix other
environments on its own:**

`migrations/047_game_category_migration.sql:29` backfills with
`WHERE game_type ILIKE 'SLOT'` — the **singular** legacy token. The real
offending row's `game_type` is the **canonical plural `SLOTS`**, so 047 never
matched it and never will, however many times the boot-time runner replays it.
`SLOT` is the only one of the five canonical categories whose code (`SLOTS`)
differs from its singular label, which is exactly why this is the one shape
that slips through.

So **prod may hold the same invalid rows right now**, silently scoring via the
legacy fuzzy fallback — and TASK-EAR-151 cannot retire that fallback while any
environment still has them.

## Objective

Land the correction as an idempotent migration so every environment is fixed
on deploy, and establish what prod actually holds — before and after.

## Scope

`Games-Labs-Missions` only: one new migration (next free number is **051**;
050 is the most recent) plus its verification. No code, proto, or FE changes.

## Required work, in this order

### 1. Write the migration

Mirror the style and guards of `047_game_category_migration.sql` and
`048_daily_pool_category_migration.sql` — read both first; they are the
in-repo precedent for exactly this operation and carry the idempotency
reasoning in their comments.

At minimum: backfill `daily_activities.game_category = 'SLOTS'` where
`game_type ILIKE 'SLOTS'` and `game_category` is NULL or `''`.

Then check — do not assume either way — whether the sibling surfaces carry the
same plural blind spot, and state in the migration comment which you covered
and why:

- `weekly_activities.game_category` (047 backfills this too, with the same
  singular-only `ILIKE 'SLOT'`)
- `daily_activity_pool_entries.entry_ref` (048) and
  `weekly_activity_pool_entries.entry_ref` (047)

### 2. ⚠️ Idempotency is a hard requirement, not a nicety

`migrations/run.go` re-executes **every** `.sql` in the directory on **every
service boot** — there is no version table. A statement that is not a no-op on
its second run will either corrupt data or crash every subsequent boot. This
workspace has already had a **production incident** from exactly this
(Games-Labs-Game's non-idempotent `ADD CONSTRAINT` crashed boots until fixed
live — see the knowledge-base lesson "Boot-Time Migration Runners That Replay
Every File"). Read it before writing a line of SQL.

The `(game_category IS NULL OR game_category = '')` guard is what makes the
backfill self-limiting: once applied, the second run matches zero rows.
Preserve that property in every statement.

Note the column shapes differ: `daily_activities.game_category` is **nullable**
while `weekly_activities.game_category` is **NOT NULL DEFAULT ''** (047:17-21),
so a guard covering only NULL would silently miss every weekly row.

### 3. Prove the second-run no-op before it goes near a real environment

Apply the migration twice against a throwaway Postgres seeded with a
representative mix — a plural-`SLOTS` row with empty category, a row 047
already fixed, a row with an unmappable `game_type`, and an already-correct
row — and prove the second run changes **zero** rows. TASK-EAR-157 did this
same throwaway-DB proof for migration 050; follow that precedent.

Report the actual row counts from both runs, not the conclusion.

### 4. Deploy to staging, then confirm the no-op there

Staging's rows were already corrected by hand, so this should be a **no-op on
staging** — which is itself the useful signal: if it reports changes, the
guards are wrong. Confirm the service came up cleanly (the boot runner fatals
on migration error, so a steady-state service is the proof it applied).

### 5. Query prod BEFORE and AFTER its deploy

This is the part that cannot be skipped or inferred.

**Before** the prod deploy, establish the actual exposure (read-only):

```sql
SELECT id, condition_type, game_type, game_category, active, updated_at
FROM daily_activities
WHERE condition_type IN ('TURNOVER_GAME_TYPE','ROUND_COUNT_GAME_TYPE')
  AND (game_category IS NULL OR game_category = '')
ORDER BY id;
```

Plus the weekly equivalent (`weekly_activities` — check for `''`, not NULL)
and the two pool tables, if step 1 concluded they are affected.

**After** the deploy, re-run the same queries and show the delta.

If prod holds rows the migration does **not** cover (an unmappable `game_type`,
like staging's `GAMEUUIDAAA` seed rows) — **report them, do not deactivate or
delete them here.** That was TASK-EAR-166's pattern and the reason matters:
`user_daily_activity_claims` and `daily_activity_progress` are both
`ON DELETE CASCADE` on `activity_id`, so a delete takes real user history with
it. Operator decides.

## Acceptance criteria

- Migration `051_*` exists, follows 047/048 conventions, and is proven a no-op
  on a second run with actual before/after counts.
- Staging deploy clean and reporting no changes.
- Prod exposure documented with real query output from **before and after**
  its deploy.
- Any prod rows outside the migration's reach reported, not silently handled.
- `go build ./...` / `go test ./...` clean.
- No commit/push/PR without operator confirmation. Prod deploy is an operator
  action; DB queries go through the operator.

## Out of scope

- Retiring the fuzzy fallback (TASK-EAR-151 — still blocked, and also needs
  TASK-EAR-168's gate redefinition).
- The weekly FISHING pool rows (TASK-EAR-167).
- Any generator code change (TASK-EAR-166, done).

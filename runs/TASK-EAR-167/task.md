# TASK-EAR-167 — Trace the weekly FISHING pool rows to their write path

## Type

investigation

## Workstream

backend

## Priority

medium

## Created

2026-07-29

## Epic

Canonical game-classification (TASK-EAR-140..153) — a loose end surfaced by
TASK-EAR-162's gate check. Does **not** block TASK-EAR-166; runs alongside it.

## Context

TASK-EAR-162's live staging queries (2026-07-29, results in
`runs/TASK-EAR-162/handoff.md`) found:

- `weekly_activities` with empty `game_category`: **0 rows** — clean.
- `weekly_activity_pool_entries` with `entry_ref` outside the five canonical
  codes: **16 rows**, all `entry_type='category'`, all `entry_ref='FISHING'`,
  spanning seeded/generated activity ids through the week of 2026-07-27.

This is **real config drift** pointing at a category that does not exist in
the canonical set. Two earlier readings of it are both unproven:

1. **2026-07-22 said it was inert** — "no FISHING game exists in the catalog,
   so it could never match via any path; pre-existing dead config, not an epic
   gap." That dismissal was made before the generator defect was understood.
2. **2026-07-27 (mine) implied the generator produced it** — a non-canonical
   label like "Fishing" is exactly what `categoryToGameType` turns into
   `FISHING` while `categoryToGameCategory` returns empty. Plausible, but
   **the pool write path was never traced**, and pool entries are written by
   different code than the `daily_activities`/`weekly_activities` rules where
   that defect was proven.

Neither should be treated as settled. This task decides it with evidence.

## Objective

Determine **what wrote those 16 rows and whether they can score**, then say
plainly which of the two readings above is correct — or that it is a third
thing.

## Investigation

1. **Trace the write paths.** `weekly_activity_pool_entries` is written in at
   least two places in `Games-Labs-Missions/internal/repositories/mission_repo.go`
   (`:3367` and `:3510`, each preceded by a `DELETE ... WHERE activity_id`
   at `:3353` / `:3501` — i.e. full replace-on-save). Identify every caller
   of each: admin save path, schedule generator, seed/fixture, migration.
   Note that `daily_plan_repo.go:372` says it mirrors these methods, so check
   whether the daily side shares the shape.
2. **Determine the origin of `FISHING` specifically.** Is it seeded fixture
   data, an operator-entered value from the Backoffice weekly editor, or
   generator output? The activity ids in the result set (seeded/generated mix,
   through the week of 2026-07-27) are the lead — recent ids mean something
   is still writing it, which matters far more than the historical rows.
3. **Establish whether these rows can ever match.** Per
   `activity_match.go:95-115` (`TURNOVER_GAME_POOL`), `PoolGameTypes` is
   matched by exact `evt.GameCategory` comparison first, then the legacy
   `gameTypeMatches` fuzzy fallback against `evt.GameType`. Confirm against
   the Game catalog whether any game could produce `game_type`/`game_category`
   that matches `FISHING` through **either** path — the 07-22 check only
   asked whether a FISHING *game* exists, which is not the same question.
4. **Check for a canonical-set gap.** Does a "Fishing" category exist in
   `Games-Labs-Game`'s `game_categories` table (it is admin-extensible per
   migration 030)? If an admin added it there but Missions' hardcoded five
   never learned it, that is the **same ownership divergence TASK-EAR-166 is
   fixing**, just on the weekly pool surface — and it would mean 166's fix
   must cover this path too.

## Acceptance criteria

- A definitive answer on what writes `entry_ref='FISHING'`, with file:line for
  the write path and evidence for the origin.
- A clear statement of whether those 16 rows can score via exact match, via
  fuzzy fallback, or not at all — with the reasoning, not just a verdict.
- An explicit ruling on whether this is (a) inert dead config, (b) the
  TASK-EAR-166 generator defect on another surface, or (c) something else.
- If it turns out TASK-EAR-166's fix would **not** cover this path, say so —
  that is the finding that matters most, since it would mean the epic still
  has an open hole after 166 lands.
- If the rows should be cleaned up, note it as a recommendation with the
  correct ordering (code fix before data, per the epic's recorded lesson) —
  but do **not** perform the cleanup in this task.

## Out of scope

- Fixing the generator (TASK-EAR-166).
- Retiring the fuzzy fallback (TASK-EAR-151, still blocked).
- Any data mutation. Read-only investigation; DB access is via the operator.

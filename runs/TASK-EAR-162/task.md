# TASK-EAR-162 — Re-run TASK-EAR-151 gate check (retention window elapsed)

## Type

investigation

## Workstream

backend

## Priority

medium

## Created

2026-07-27

## Context

Child of the canonical game-classification epic, specifically gating
[TASK-EAR-151](../TASK-EAR-151/task.md) (Phase 5: retire the fuzzy
fallback). Operator agreed a retention window on 2026-07-22: 3 days from
TASK-EAR-153's deploy (commit 5fd3fea2), i.e. re-run the gate check on or
after 2026-07-25. **Today is 2026-07-27 — the window has elapsed.** This
task is purely to re-run the gate check and report results; it does
**not** authorize removing the fallback.

The previous run (2026-07-22, pre-TASK-EAR-153) failed:
`applied_forward_legacy_fuzzy = 5`, traced to `daily_activity_pool_entries`
not yet being migrated. TASK-EAR-153 has since migrated it and deployed to
staging (verified). This run checks whether that fix actually brought the
fallback rate to zero under live traffic since then.

## Goal

Run BOTH checks below against the **staging** database and report the raw
numbers. A single post-deploy snapshot is not enough — the point is
proving the fallback rate stays zero under live traffic since
TASK-EAR-153 deployed (2026-07-22), not that one moment happened to read
zero.

### 1. Daily metric

```sql
SELECT status, COUNT(*)
FROM daily_activity_consumer_events
GROUP BY status;
```

Gate passes only if `applied_forward_legacy_fuzzy` is 0 (or absent).

### 2. Weekly direct verification (the metric above cannot see weekly at all)

```sql
SELECT id, condition_type, game_category
FROM weekly_activities
WHERE condition_type IN ('TURNOVER_GAME_TYPE','ROUND_COUNT_GAME_TYPE')
  AND (game_category IS NULL OR game_category = '');

SELECT id, entry_type, entry_ref
FROM weekly_activity_pool_entries
WHERE entry_type = 'category'
  AND (entry_ref IS NULL OR entry_ref NOT IN
       ('SLOTS','CRASH','ARCADE','MINIGAME','CARD'));
```

Gate passes only if both queries return zero rows. (Note: a
`weekly_activity_pool_entries` row with `entry_ref='FISHING'` was already
investigated on 2026-07-22 and ruled out as a pre-existing dead reference,
not an epic gap — no live `FISHING` game exists in the catalog. If it's
still the only row that shows up, that's expected and does not fail the
gate; call it out by name in the report rather than treating it as new.)

## How to connect

No committed script exists for this — find the staging Postgres access
path yourself first (check `Games-Labs-Missions` deploy/infra config,
`.github/workflows/`, and how prior gate checks in this epic's history
were run) before assuming a specific method. If no safe, already-documented
access path can be found, stop and report that instead of improvising
credentials or opening new access.

## Scope

- Read-only. Query staging DB only. No schema changes, no code changes, no
  PRs.
- Do **not** act on TASK-EAR-151 (removing the fuzzy fallback) regardless
  of outcome — that decision goes back to the operator with these numbers.

## Acceptance

- Both raw query results reported verbatim (not just pass/fail).
- Clear verdict: gate PASSES (both conditions met) or FAILS (which
  condition and by how much).
- If FAILS, note whether the failure looks like the same root cause as
  2026-07-22 (unmigrated pool entries) or something new.

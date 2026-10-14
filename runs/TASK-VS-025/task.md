# TASK-VS-025: Shared closed-day admin aggregates table (status counts + bank flows) computed once across tasks

## Why (operator chose option B on 2026-10-14)
Prod EXPLAIN (TASK-VS-024 `explain-bank-flows-prod-2026-10-14.md`, 15:53 ICT, read-only) found:
- All indexes valid. Normal and generic plans both use an index scan; no seq scan.
- One Bangkok day = 202,951 verified rows. The bank-flow query costs ~203k shared buffers and ~2.0s,
  because it reads banks and amounts from every row. Status counts are index-only: ~3k buffers, 0.26s.
- The 15s failures come from repetition. Every task recomputes every closed day on every deploy, and the
  VS-024 boot warm-up ran ~6 such queries at once, so it timed out on all 3 prod tasks.

## Change (SparqLab/slip-api#65, 4d4fafc)
- Migration 058 `admin_day_aggregates (kind, scope, day) -> jsonb`, written only for closed days.
  `kind` is versioned.
- The closed-day caches read memory -> table -> compute, and store what they compute
  (ON CONFLICT DO NOTHING). A store failure is logged and the caches fall back to computing.
- Boot warm-up runs only in the task holding `pg_try_advisory_xact_lock`; the others load stored days.
- `SetDayAggregateStore` is wired in main.go; without it behaviour is unchanged.

## Deploy order / rollback
- The migration ships with the code (goose at boot). It creates a new empty table and does not lock
  `verifications`. Deploy staging, then prod.
- Rollback: revert the code (the table becomes unused). 058 Down drops it.
- Data fixes that rewrite verification status/created_at/banks/amount must delete the affected days or
  bump `kind`.

## Evidence
- ev-001: vet + full suite with real Postgres + race + store round-trip/lock test, green.
- ev-002: on origin/main the new service tests fail to compile (new API). A mutation check (store load
  disabled) made both cross-task tests fail. That run happened in-session and was not recorded as evidence.
- Pre-existing, not touched: TestAdminDailyCountsUsesBangkokDates fails on a reused local test DB because it
  never deletes its 2037 rows. It also fails on origin/main.

## Acceptance (prod)
- Exactly one task logs `admin day caches warmed`; the others log `another task is warming`.
- After that, a redeploy computes no closed days: its warm-up is fast and `admin_day_aggregates` holds the
  month.
- KBank flow 7 days / This month: summary + transfers 200 within a few seconds.

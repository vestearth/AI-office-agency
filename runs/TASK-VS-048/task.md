# TASK-VS-048: Merchant usage/statistics reads fast for high-volume branches (no raw verifications scan)

- Type: performance (slip-api only, with a migration). Follow-up of TASK-VS-047.
- Created: 2026-10-25 by the Claude conductor lane, which was asked by the TASK-VS-047 session to implement it.
- Gates: `implementation_verification`, `knowledge_closeout`. Promotion to staging and prod is not part of this run; Earth approves it separately.
- Design and option comparison: [`decision-memo.md`](decision-memo.md).

## Problem

These slip-api methods in `internal/repositories/verification.go` aggregate raw `verifications` rows over the whole request range:

- `UsageByUser`, `MonthlyUsageByUser` and `CountByUser`
- the four `MerchantDashboard*` aggregations

Branch `816d9bc9-76f1-4817-89ee-e86dbe5deb2c` (merchant `84006774-…`) writes about 590k rows a day, so these reads exceed the 3s repository timeout. `CountByUser` also exceeds its 10s floor.

Effect on prod:

- **500:** `/v1/usage`, `/v1/usage/monthly` and `/v1/merchants/{id}/dashboard/summary*` (prod census in the memo).
- **Empty usage instead:** branch package detail, overview and the API channel show empty usage (TASK-VS-047 fallback). Overview takes about 16s.

## Scope

- Migration `065_verification_usage_hourly.sql`:
  - an hourly rollup table plus a single-row coverage state;
  - a row trigger on `verifications` for insert, delete and update of the counted columns.
- Readers take whole covered hours from the rollup and the range edges from `verifications`, so results stay exact. Readers changed: `UsageByUser`, `MonthlyUsageByUser`, `CountByUser`, `MerchantDashboardSlips`, `MerchantDashboardDaily`, `MerchantDashboardBranchCounts` and `MerchantDashboardBreakdown`.
- Backfill: `BackfillUsageHour` plus a loop in `cmd/main.go`. Each step rebuilds one hour in a REPEATABLE READ transaction under an advisory lock, then lowers `covered_from`.
- `migrations/TestGooseSQLFiles` count. It was already wrong on main: 64 files, test said 63. It now expects 65.

Out of scope: `/v1/branch-packages/history`. It fails because it lists every quota deduction with no limit, not because of an aggregation; fixing it needs a contract change (see memo). Also out of scope: the admin verification count and the email-alert and digest timeouts.

## Acceptance

- Regression tests run against PostgreSQL:
  - Whole hours are answered by the rollup. Seen failing on the old readers first.
  - Rollup reads equal hand-computed results for aligned and unaligned ranges, UTC and Bangkok day/month edges, and dashboard windows.
  - The trigger follows insert, update and delete.
  - Backfill is exact, skips gaps, waits for quiet hours and is idempotent.
- Migration test: 065 applies, re-applies harmlessly, and rolls back.
- `go vet ./...`, `go build ./...` and the full `go test ./...` pass with the repository and migration DSNs set.
- A PR into slip-api `main` from a branch cut from `origin/main` `6362929`.

## Staging (2026-10-26, Earth-approved; prod not in scope)

- Promoted by PR SparqLab/slip-api#94 (main `430ceae` → staging `c5e5c45`, with TASK-VS-049). Deploy STAGING run `40223217376` success; `slip-api-staging:154` runs `staging-sha-c5e5c45`, 1/1, rollout COMPLETED, ALB target healthy. No `USAGE_BACKFILL_*` env in the staging task definition, so defaults apply (enabled, 1s pause).
- Boot log 18:54:17Z: `goose: OK up 065_verification_usage_hourly.sql (143ms)`, `migrated database to version 65`, then HTTP started.
- Backfill: `progress` 24 h (covered_from 2026-10-14T03:00Z) at 18:54:41Z, 48 h (2026-10-01T02:00Z) at 18:55:05Z, `paused` after 64 h with covered_from `2026-09-21T08:00Z` at 18:55:22Z. No `step failed` warning, no ERROR or panic.
- **Not exercised on staging:** the usage/dashboard endpoints and the trigger under real inserts. Staging had no merchant traffic in the window, and they need a merchant JWT (no staging test account was used). Exactness rests on the repository tests (18/18 old-vs-new SQL match).

## Prod (2026-10-26, Earth-approved)

- Promoted by PR SparqLab/slip-api#95 (staging `c5e5c45` → prod `32cd203`, with TASK-VS-049). Deploy PRODUCTION run `40227467094` success; `slip-api-production:111` runs `production-sha-32cd203`, 3/3, rollout COMPLETED, targets healthy. Rollback: `slip-api-production:110` (leaves the trigger in place; it keeps the rollup current with no app dependency).
- Pre-checks done from source: app INSERT always sets `channel`/`outcome_reason`; the only app UPDATE (`idempotency_key`) is outside the trigger's column list; a failed 065 (1s lock/statement timeout) aborts boot while old tasks keep serving (minHealthy 100 %, no circuit breaker). `verifications_created_id_idx` validity was not queried (no prod DB access); the migration succeeded, which needed the index for `MAX(created_at)` within 1s.
- Migration: `goose: OK up 065_verification_usage_hourly.sql (77ms)` at 19:47:37Z on task `91bbe5214211`; version 65.
- Backfill: started 20:05:30Z (first hour 19:00Z, after the 5-minute quiet window); tasks take turns on the advisory lock; covered_from passed 30 days (`2026-09-25T03:00Z`) at 20:17:50Z; 42 log lines, 0 `step failed`.
- Insert latency (`slip_verify` 200, all branches), 47 min each side:

  | Window | n | p50 | p95 | p99 | max | 5xx |
  |---|---|---|---|---|---|---|
  | before 18:58–19:45Z | 8,395 | 195 | 446 | 740 | 3,478 | 0 |
  | after 19:47–20:34Z (trigger on) | 7,231 | 194 | 443 | 661 | 3,265 | 0 |

  Verifies over 2s in 15.5 min: 10 after vs 22 before (same-length window) and 20 a day earlier — the ~2.2s/3.2s tail predates the trigger.
- RDS, 5-minute max:
  - **ReadIOPS** (ev-011): about 15 before. 981, 757 and 514 in the backfill buckets (cold history reads). 919 in the 19:45Z bucket, which is the rolling deploy, before the backfill started; old tasks were still timing out on this merchant's usage reads then.
  - **WriteLatency** (ev-012): 3.2–3.7 ms during the backfill, unchanged. One peak of 29.4 ms in the 19:45Z deploy bucket.
  - **ReadLatency:** 0.6 ms.
  - **CPU:** max 9–10 %.
  - **Connections:** 125–130 during the rolling deploy, 86 after.
  - *Corrected 2026-10-26: an earlier version of this line put the 919 ReadIOPS bucket in the backfill and gave the WriteLatency max as 3.2 ms.*
- **ev-007:** merchant `84006774` page loads at 20:31–20:34Z (Earth opened them) — all 200: overview 51–56 ms (was 16 s), channels/api 63–209 ms (was 6.4 s), branch-packages/{id} 52 ms (was 3 s), `/v1/usage` 20–43 ms and `/v1/usage/monthly` 21–30 ms (were 500). The `/v1/usage*` log lines carry no merchant id; they arrived in the same seconds as that merchant's page loads.
- **ev-008:** Earth called the dashboard at 20:34–20:40Z — merchant `84006774` `dashboard/summary`, `summary-today`, `summary-total`, `summary-daily`, `summary-breakdown`, `credits`: 48 calls, all 200, 4–461 ms (first load 454–461 ms, then 50–210 ms). Before the deploy these returned 500 after the 3s timeout (e.g. 19:45:34Z on td 110).

## Follow-up: PR #85 migration renumbered to 066 (2026-10-26, Earth-requested)

- Open PR SparqLab/slip-api#85 (admin day aggregate invalidation) also used migration `065`. Git merged both `065_*.sql` files with no conflict, and goose would refuse to boot.
- Fixed on the PR branch `cursor/admin-aggregate-invalidation-297c`, fast-forward with no force-push:
  - `0adf9ad` merges `main` into the branch.
  - `d80825e` renames the branch's file to `066_admin_day_aggregate_invalidations.sql` (SQL unchanged) and sets `TestGooseSQLFiles` to 66.
  - The PR body now says 066 and has a "Renumbered to 066" note.
- Verified on a throwaway `postgres:18.3` container (removed afterwards), with `SLIP_API_REPOSITORY_TEST_DSN` and `SLIP_API_MIGRATION_TEST_DSN`. The `migrations` and `repositories` packages pass, 56 tests with none skipped, and `goose_db_version` shows 64, 65, 66 applied in order. `go vet`, `go build` and `go test ./...` pass.
- PR #85 is MERGEABLE and not merged.
- **Backfill end state is open.** The last log (ev-009) is `paused` at covered_from `2026-09-25T03:00Z`, and no progress followed in 30+ minutes. That does **not** prove history is covered.
  - ev-013 shows 13,974 verify-200 log lines on prod from 2026-09-22T07:38Z to 2026-09-24T09:10Z, mostly merchant `6f798b3c`, the 2026-09-24 load test.
  - `BackfillUsageHour` returns zero with no log in five cases: lock not won; no state row; no row below `covered_from` (`newest == nil`); the hour is too recent; or a 40001/23505 error.
  - So either those rows were deleted from `verifications` (no record says so), or the step for `[2026-09-24T09:00Z, 2026-09-25T03:00Z)` fails silently on every retry.
  - Readers stay exact either way, because hours below `covered_from` are read from raw `verifications`; that range is about 14k rows.
  - Confirm with read-only SQL: `SELECT covered_from FROM verification_usage_hourly_state;` and `SELECT MAX(created_at) FROM verifications WHERE created_at < '2026-09-25T03:00Z';`.
  - Follow-up: log when a backfill step is skipped for 40001/23505, so a stalled backfill is visible.
  - *Corrected 2026-10-26: the earlier text inferred "no older rows" from the silence.*

## Follow-up: PR #85 promoted to prod (2026-10-26, Earth-approved)

- **Merge:** SparqLab/slip-api#85 was merged into `main` as `7aee086` at 03:11Z. The merge tree is identical to the tested `d80825e`. Its branch `cursor/admin-aggregate-invalidation-297c` was deleted after the merge.
- **Promotion:** #96 promoted `main` → `staging` as `56ba3b1`, and #97 promoted `staging` → `prod` as `8477b0a`. Each PR carried only #85's 19 files.
- **Staging (ev-015):**
  - Deploy run `40263958500` succeeded. `slip-api-staging:155` runs `staging-sha-56ba3b1`.
  - Log at 03:27:41Z: `goose: OK up 066_admin_day_aggregate_invalidations.sql (92ms)`, version 66, HTTP started, `admin day caches warmed` (119 ms). `/health` returned 200, and the new endpoint without a token returned 401.
  - **The staging RDS `upslip-postgres-dev` (db.t3.micro) hit `FATAL: sorry, too many clients already` (SQLSTATE 53300):**
    - 93 lines on the old pre-#85 task `a9a5a8c22ecd` (02:52:57Z–03:16:19Z, before the deploy started at ~03:24Z);
    - 61 lines on the new #85 task `af48cb8a37c6` (03:30:49Z–03:37:25Z).
  - Mostly `claim queue job failed`, plus `branches/summary` 500s on the old task.
  - **Connections, 1-minute max:** ~23–26 normally. 48 from 03:17Z, which is before the deploy, cause unknown. 63–66 during the 03:28–03:34Z task overlap. 23 again from 03:35Z.
  - At 03:37Z, errors appeared while the metric showed 23. So `max_connections` is low, or the spikes are shorter than one metric sample.
  - #85 opens no new pool; it polls the invalidation log every 15 s through the existing one. The saturation started before #85.
  - **Correction:** PR #97's body and an earlier chat report said "0 ERROR lines after the old task drained at 03:34:30Z". That was wrong. The check ran at 03:36:50Z, before CloudWatch had ingested the 03:37Z lines; ev-015 shows 87 ERROR lines from 03:34:30Z to 03:40Z.
  - **Follow-up, not in this task:** size the staging RDS or cap `POSTGRES_MAX_CONNS` for staging, and find the 03:17Z connection jump.
- **Prod (ev-016):**
  - Deploy run `40264965074` succeeded. `slip-api-production:112` runs `production-sha-8477b0a` with 3 of 3 tasks; the rollout completed at 03:47:56Z and all targets are healthy.
  - Log at 03:40:06Z: `goose: OK up 066 (44ms)`, version 66. All three new tasks logged `admin day caches warmed` in 11–33 ms, and the old tasks drained at 03:46Z.
  - **Errors:** none (0 5xx or ERROR lines) from 03:37Z to 03:47Z.
  - **Verify latency:**

    | Window | n | p50 | p95 | p99 | max | 5xx |
    |---|---|---|---|---|---|---|
    | before, td 111 (03:30–03:37Z) | 2,035 | 232 ms | 609 ms | 2,292 ms | 3,895 ms | 0 |
    | after, td 112 (03:40–03:47Z) | 2,021 | 211 ms | 503 ms | 2,327 ms | 3,483 ms | 0 |

  - The admin report pages and the invalidate endpoint were not called after the deploy; only `/v1/admin/me`, which returned 200 ×18.
- **Rollback:** `slip-api-production:111` (`production-sha-32cd203`). Migration 066 only creates a table, so the old code ignores it.
- **Operating note:** call `POST /v1/admin/report-aggregates/invalidate` only when every task runs this release, and not during a rolling deploy.

## Review Queue follow-up — 2026-10-26 (Codex, read-only access check)

Picked the factual backfill end-state question from Knowledge Base/Review
Queue.md. The end state remains unverified; this access failure is not proof
of a stalled or completed backfill.

Observed:

- AWS identity was verified with explicit profile vestearth and region
  ap-southeast-1: expected account and IAM operator matched workspace policy.
- RDS upslip-postgres-prod is available and PubliclyAccessible=false.
- A 5-second PostgreSQL TCP probe from this workstation timed out. DBeaver's
  existing slip production connection also returned Connection attempt timed
  out. No query was executed through DBeaver.
- Existing slip-api production task has ExecuteCommandAgent RUNNING and
  enableExecuteCommand=true. ECS Exec reached its container; psql, python3,
  node and openssl were absent from PATH (nc exists).
- SSM DescribeInstanceInformation and StartSession port forwarding were denied
  for the operator identity. No IAM, network or deployment setting was changed.

Next verification must run through an already-authorized private-network SQL
connection. Use one consistent read-only snapshot and a short timeout:

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SELECT current_database(), transaction_read_only
FROM (SELECT current_setting('transaction_read_only') AS transaction_read_only) s;
SELECT covered_from,
       (SELECT MAX(v.created_at)
        FROM verifications v
        WHERE v.created_at < s.covered_from) AS newest_before_coverage
FROM verification_usage_hourly_state s;
ROLLBACK;
```

Exactly one state row plus NULL newest_before_coverage proves there are no
raw verification rows older than coverage at that snapshot. A non-NULL
value proves older raw rows remain, but does not establish why. No state row
means coverage is uninitialized, not completed. Source:
internal/repositories/verification_usage_hourly.go (usageCoveredFrom,
BackfillUsageHour and rebuildUsageHour). No row-level customer data or secret
was read or written; no task completion gate or phase was changed.

## Production read-only coverage result — 2026-10-26 13:40 ICT (Codex)

After Earth reopened DBeaver, its existing slip connection connected to the
production RDS database. A new SQL Console preserved Script-11. Executed the
BEGIN REPEATABLE READ READ ONLY / SET LOCAL timeouts / SELECT / ROLLBACK
script above, using current_database() and current_setting() in the SELECT.
The result grid contained exactly one row:

| database_name | read_only | checked_at | covered_from | newest_before_coverage |
|---|---|---|---|---|
| slip | on | 2026-10-26 13:40:37.316 +0700 | 2026-09-25 10:00:00.000 +0700 | NULL |

UTC equivalents: checked_at 2026-10-26T06:40:37.316Z; covered_from
2026-09-25T03:00:00Z. The result was observed directly in DBeaver's result
grid; this is a manual UI observation, not an ev-NNN execution record.
The script finished with ROLLBACK; no rows were changed.

Conclusion: no existing verification row predates covered_from in that
snapshot. The Review Queue backfill end-state question is resolved for the
then-existing data. The earlier inference that a silent retry was more likely
is not supported by this result. It does not prove deletion, retention,
completeness of historical ingestion, or equality of all rollup totals.
The 13,974 earlier verify-200 log lines are not proof of rows currently in
this table. Skipped-step logging remains an optional observability follow-up;
this query does not demonstrate that a 40001/23505 retry is occurring.
Other VS-048 follow-ups and its phase are unchanged by this narrow closure.

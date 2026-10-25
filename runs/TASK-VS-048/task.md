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
- RDS (5-min max): ReadIOPS ~15 → 830–980 during backfill (cold history reads); WriteLatency max 3.2 ms and ReadLatency 0.6 ms unchanged; CPU max 9–10 %; connections 125–130 during the rolling deploy, 86 after.
- **ev-007:** merchant `84006774` page loads at 20:31–20:34Z (Earth opened them) — all 200: overview 51–56 ms (was 16 s), channels/api 63–209 ms (was 6.4 s), branch-packages/{id} 52 ms (was 3 s), `/v1/usage` 20–43 ms and `/v1/usage/monthly` 21–30 ms (were 500). The `/v1/usage*` log lines carry no merchant id; they arrived in the same seconds as that merchant's page loads.
- **ev-008:** Earth called the dashboard at 20:34–20:40Z — merchant `84006774` `dashboard/summary`, `summary-today`, `summary-total`, `summary-daily`, `summary-breakdown`, `credits`: 48 calls, all 200, 4–461 ms (first load 454–461 ms, then 50–210 ms). Before the deploy these returned 500 after the 3s timeout (e.g. 19:45:34Z on td 110).

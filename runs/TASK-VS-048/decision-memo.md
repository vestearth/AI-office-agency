# TASK-VS-048 decision memo: how merchant usage reads stop scanning raw verifications

Written 2026-10-25, before implementation, against slip-api `origin/main` `6362929`
(contains the TASK-VS-047 hotfixes #86 and #89; prod runs the same code as
`slip-api-production:110`).

## Problem

Every merchant usage/statistics read aggregates raw `verifications` rows over its
whole range. Branch `816d9bc9-…` writes about 590k rows a day (about 400 verifies a
minute), so a 30-day window is about 17M rows. The reads exceed the 3s repository
`queryTimeout` (`cmd/main.go:83`) or the 10s `CountByUser` floor.

Prod census, `/ecs/slip-api-production`, 24h to 2026-10-25 ~16:30Z (`filter-log-events`):

| Error (as logged) | Count | Endpoint |
|---|---|---|
| `usage: usage verifications: … deadline exceeded` (`branch usage unavailable`, non-fatal since #86) | 68 | overview, channels/api, branch-packages/{id} |
| `usage: usage verifications: …` (`reports request failed`) | 9 | `/v1/usage` (500 at ~3.0s) |
| `monthly usage: monthly usage verifications: …` | 9 | `/v1/usage/monthly` (500 at ~3.0s) |
| `merchant dashboard slips / daily / branch counts / breakdown: …` | 10 / 3 / 3 / 3 | `dashboard/summary`, `-today`, `-daily`, `-total`, `-breakdown` (500 at ~3.0s) |
| `count verifications: …` (`overview_recent`, non-fatal since #89) | 2 | overview (adds 10s) |
| `list quota deductions: …` | 9 | `/v1/branch-packages/history` (500 at ~3.0s) — **different cause, see Out of scope** |

## Reads that must be served

All filter on `user_id` (the owner) plus optional `merchant_id`, `branch_id` or
`branch_id = ANY(…)`, `channel`, `status`, and a `created_at` range
(`verificationHistoryWhere`, `internal/repositories/verification.go:1016`).

| Method | Groups by | Day edge |
|---|---|---|
| `UsageByUser` | day, status, channel, outcome_reason | **UTC** day |
| `MonthlyUsageByUser` | month, channel (api/line only) | Asia/Bangkok month |
| `CountByUser` | – (one total) | – |
| `MerchantDashboardSlips` | 3 windows (range, previous range, Bangkok yesterday); pass bucket, failure reason, SUM of numeric `amount` for passed and for receiver-mismatch rows | window edges |
| `MerchantDashboardDaily` | Bangkok day, bucket | Bangkok day |
| `MerchantDashboardBranchCounts` | branch | – |
| `MerchantDashboardBreakdown` | bucket, channel | – |

Buckets and failure reasons are functions of `(status, outcome_reason)`, and the
amounts are sums over rows with the same key, so a rollup keyed on
`(status, channel, outcome_reason)` with a count and an amount sum answers all of
them exactly. Ranges are not always day-aligned: the default `to` is `now`, the
default `from` is `to - 30 days`, and the previous-range window starts at
`from - (to - from)`.

## Options

### A. Rollup table maintained on insert (chosen, at hour grain)

`verification_usage_hourly(user_id, merchant_id, branch_id, hour, channel, status,
outcome_reason) → verification_count, amount_total`, kept by an `AFTER INSERT OR
DELETE OR UPDATE OF <those columns>` row trigger on `verifications`.

- **Why hours, not days.** The readers mix UTC days (`UsageByUser`), Bangkok days and
  Bangkok months, and both zones are whole-hour offsets with no DST, so every
  bucket any reader needs is a union of whole UTC hours. A daily rollup keyed on one
  zone cannot answer the other. Size stays small: about 24 hours × ~10 keys ≈ 240 rows
  per branch-day, so a 30-day window is ~7k rows instead of ~17M.
- **Exact for any range.** A read takes the whole hours inside the range from the
  rollup and only the edges from `verifications`: the part before the first whole
  hour, the part after the last one (at most one hour each; ≤ ~24k rows for the
  busiest branch, usually the partial current hour), and any hour that holds a
  dashboard window edge. Results equal the raw query to the row.
- **Why a trigger, not Go code in `insertVerification`.** The trigger also follows
  `UPDATE` and `DELETE` (tests delete rows; migrations 028, 037 and 046 rewrote rows in
  place), and any future writer, with no change to `Save` / `SaveWithQuota`. The
  idempotency-key release `UPDATE` (verification.go:103) touches none of the trigger's
  columns, so it does not fire.

### A′. Same rollup, filled by a periodic job instead of a trigger

- No write-path cost.
- Readers must still scan the open hours raw (up to ~1h05m with a quiet margin, ~25–50k
  rows on this branch). That cost grows with branch volume and returns to timeouts if
  the job stalls.
- Rows changed after their hour was rolled (late writes, data fixes, deletes) drift
  silently, the same caveat migration 058's closed-day cache documents. A also drifts
  if the trigger is bypassed (TRUNCATE, trigger disabled, `session_replication_role`),
  but not on ordinary updates and deletes.
- Needs a leader across ECS tasks. A's backfill needs one too, but only until history
  is covered.
- The 058-style closed-day read-through cache is the same idea with even more raw:
  the whole open day (up to 590k rows here).

### B. Covering index

- For example `(branch_id, created_at) INCLUDE (status, channel, outcome_reason, amount)`.
- It removes heap fetches but is still O(rows): ~17M index entries per 30-day read,
  roughly 2s or more for one query even index-only, and overview runs three.
- Index-only scans also need the visibility map, and the newest pages (today) are not
  all-visible, so recent rows still go to the heap. Insert-autovacuum tuning was
  deferred by the operator on 2026-10-16 (TASK-VS-030).
- Write cost: a 19th index on a >5 GB, insert-heavy table, plus a long
  `CREATE INDEX CONCURRENTLY` (two table scans) at deploy.
- It misses the 3s budget and gets worse with every day of volume.

### C. Overview skips the total COUNT

- Overview shows 5 recent rows, not the total, so skipping `CountByUser` there saves 10s
  of the ~16s.
- It fixes nothing else: `/v1/usage`, monthly, the dashboards and the overview's two
  usage calls still time out.
- With A in place, `CountByUser` is answered by the rollup too (the history page also
  benefits), so C adds nothing and is **not implemented**. It is still an independent
  10s saving if A ever has to be rolled back.

## Write-path cost of A at ~400 verifies/min (≈ 6.7/s)

- **Per verify:** one `INSERT … ON CONFLICT DO UPDATE` on a small table, i.e. one probe
  of a small, hot B-tree plus one heap update. The counters are not indexed, so with
  `fillfactor = 70` the update is HOT (no index writes) and pages prune themselves.
  WAL is roughly 150–250 B.
- **For comparison:** the verification insert it rides on writes a ~1–2 KB tuple and
  18 index entries. The fast path already adds a `quota_history` insert per verify
  (`branch_package.go:789`). The upsert is a few percent of that transaction.
- **Hot row:** the busiest key, (branch, current hour, api, verified, ''), takes ~6.7
  updates/s, and each holds the row lock until its commit.
  - `SaveWithQuota` already locks the same branch's `branch_packages` row earlier in the
    same transaction (`consumeQuotaFastPath`), so these transactions are already
    serialized per branch. The rollup lock is taken later and released at the same
    commit, so it adds no new queueing point.
  - `Save` (no quota) commits immediately.
  - Lock order is always branch_packages → verifications → rollup, so it cannot deadlock.
- **Dead tuples:** ~590k row versions/day land on a few hundred rows; HOT pruning
  reclaims them in-page, and autovacuum of a small table is cheap.
- **Trigger overhead:** PL/pgSQL adds tens of microseconds per row. A future bulk data
  fix pays it per row; that is documented in the migration.

### Measured locally (PostgreSQL 16 on a laptop; relative numbers only)

- **Reads.** A synthetic branch with 1.68M rows over 7 days (10k/hour, about 40% of
  this branch's peak rate). These numbers are a floor for prod: local data is warm,
  rows are narrow, and prod has ~10× the rows per 30 days.
  - Raw reads took 93–687 ms per method.
  - Rollup reads took ≤ 1 ms, with identical totals.
  - The backfill rebuilt 168 hours in 2.9 s (median step 14 ms, max 50 ms).
- **Writes.** pgbench, single-row inserts.
  - **One client:** 0.220 → 0.245 ms per insert, about +25 µs. A second run was within
    noise.
  - **Eight clients on one rollup key at ~10k inserts/s:** 9.5–10k TPS fell to 2.2–5.5k
    TPS, because every update hits one hot row. That rate is ~1000× prod's per-branch
    rate, and in prod the `branch_packages` row lock already serializes the same
    writers before the trigger runs.
- Logs: `evidence/manual-local-bench-*.log`. These are local-only, as runs/ keeps logs
  out of git.

## Decision

**A**: an hourly rollup kept by a trigger, a backfill job that rebuilds history hour by
hour, and readers that combine rollup hours with raw edges. It is the only option that
is exact, keeps reads O(hours) at any branch volume, and needs no job to stay fresh.
The write cost is a small, bounded addition to a transaction that already serializes
per branch. B misses the budget, C fixes one page, and A′ keeps a raw tail that grows
with volume.

## Migration plan (`065_verification_usage_hourly.sql`, one goose transaction)

All statements are idempotent: `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE
FUNCTION`, `CREATE OR REPLACE TRIGGER`, `INSERT … ON CONFLICT DO NOTHING`. goose applies
each version once per database, and a re-run is harmless. `OR REPLACE` keeps a re-run at
SHARE ROW EXCLUSIVE; `DROP TRIGGER` would take ACCESS EXCLUSIVE (checked on PG 16).

1. Create `verification_usage_hourly` (PK `(user_id, merchant_id, branch_id, hour,
   channel, status, outcome_reason)`, `fillfactor = 70`) and an index on `hour` for the
   backfill. No foreign keys: they would add key-share locks on users/merchants/branches
   to every verify.
2. Create `verification_usage_hourly_state`, a single row holding `covered_from`: the
   first hour from which the rollup holds every row.
3. Create the trigger function (hour = `date_trunc('hour', created_at, 'UTC')`,
   independent of the session TimeZone). Decrements delete rows that reach 0.
   - The UPDATE/DELETE branch takes the backfill's advisory lock **shared** (see
     Backfill).
   - The app never updates a counted column, so inserts, which skip this lock, pay
     nothing for it.
4. `SET LOCAL lock_timeout = '1s'` and `statement_timeout = '1s'`, then
   `CREATE OR REPLACE TRIGGER`. It takes SHARE ROW EXCLUSIVE on `verifications` until
   commit, so verify inserts pause for the migration's few milliseconds.
   - While it waits in the lock queue, new inserts queue behind it. Waiting at most 1s,
     then holding at most 1s for the MAX below, keeps that stall under the 3s
     `SaveWithQuota` budget.
   - A plain autovacuum is cancelled after `deadlock_timeout`. An index build, an
     anti-wraparound vacuum, or a MAX that cannot use `verifications_created_id_idx`
     fails the boot instead, and ECS retries it.
5. Seed `covered_from = GREATEST(this hour, hour of max(created_at)) + 1 hour`, using
   `clock_timestamp()` after the lock is held. No pre-existing row can fall at or after
   it, and every later row passes through the trigger. A `CHECK` keeps `covered_from`
   on a whole hour.

**Down:** under a 1s `lock_timeout` (`DROP TRIGGER` takes ACCESS EXCLUSIVE), drop the
trigger, the function and both tables.

## Backfill

- A loop in every API task (`cmd/main.go`, beside the other `run*Loop`s) calls
  `BackfillUsageHour`.
- Each call first takes `pg_try_advisory_xact_lock` in a lock-only transaction, then
  opens one REPEATABLE READ transaction, so its snapshot starts after the lock is held:
  1. Take the hour `h` of the newest verification below `covered_from`.
  2. Require `h + 1h + 5 min ≤ now`, so the hour is quiet.
  3. Delete rollup rows in `[h, covered_from)`.
  4. Insert the raw aggregate for that range.
  5. Set `covered_from = h`.
- Empty gaps are skipped in one step, and the job ends when no row is older than
  `covered_from`.
- **Why it is exact:**
  - REPEATABLE READ makes the delete, the raw read and the insert share one snapshot.
  - A racing **insert** that touches the same rollup rows makes the step fail with
    40001 or 23505. That is treated as "not this time", and the next call retries.
  - A racing **update or delete** of a row written before the trigger is the one case
    that no row conflict can catch: its decrement finds nothing to take from. Review
    reproduced the double count. Such writes therefore take the same advisory lock
    shared, so they and a step exclude each other: the step's try-lock fails while one
    is open, and they wait for a running step to commit. Regression test:
    `TestBackfillUsageHourDoesNotRaceDataFixes`.
  - Not covered: writes that bypass the trigger (TRUNCATE, a disabled trigger,
    `session_replication_role = replica`). After one of those, raise `covered_from`
    above the affected hours.
- **Repair:** setting `covered_from` higher, to a whole hour, rebuilds everything below it.
- **Pacing:**
  - The step leader waits `USAGE_BACKFILL_PAUSE` (default 1s) after each step that
    advances. Non-leaders, and the leader once history is complete, check once a minute.
  - `USAGE_BACKFILL_ENABLED=false` turns the loop off. Coverage then stays where it is
    and reads stay exact; they just read more raw.
  - **Load:** each step reads one hour of verifications through an index. On prod, that
    pushes the heap through shared_buffers over the first sweep. On staging, watch the
    cache hit ratio, read IOPS and insert p99 during the sweep, and slow it with the
    pause if needed.
- **Duration:**
  - One busy hour of platform traffic is ~25k rows, about 0.2–1 s per step plus the 1s
    pause. The last 30 days (720 steps) take about 15–25 min.
  - Until then, a range that reaches below `covered_from` reads that part raw, the same
    as today.
  - The cutover hour becomes quiet up to ~65 min after deploy, so the merchant pages
    turn fast roughly 1h20–1h30 after deploy.

## Deploy order and rollback

- **Deploy:** slip-api only, migration on boot, additive. No ordering constraint with
  other services.
- **App rollback** (previous task definition): safe. Old code never reads the rollup.
  The trigger keeps it current, so rolling forward again needs no new backfill.
- **Schema rollback:** `goose down` one version (the Down block) after or alongside the
  app rollback. New code treats a missing state table as "no coverage" and reads raw,
  as before.
- **Staging check:** state row and trigger exist, the backfill logs reach history start,
  and `/v1/usage` and dashboard totals for a staging merchant match the pre-deploy
  numbers.
- **Read-only checks before the prod deploy** (DBeaver, `BEGIN READ ONLY … ROLLBACK`):
  - `SELECT indisvalid FROM pg_index WHERE indexrelid = 'verifications_created_id_idx'::regclass`
    must be `true`, so the migration's MAX uses the index.
  - `SELECT max(created_at) FROM verifications` must be close to now. A future-dated row
    pushes the start of coverage forward.
  - `channel` and `outcome_reason` are `NOT NULL` (migrations 011/028; channel was
    confirmed on prod 2026-10-16). Re-check if in doubt.
- pgx runs in its default exec mode (the DSN sets only `sslmode`), so timestamps travel
  in binary, truncated to µs, which the edge splitting assumes.

## Review (2026-10-26, independent reviewer agent)

- **Verdict:** "ready after fixes". It found no case where a read differs from the old
  SQL. It ran the 7 old readers verbatim against the new ones: 6 edge-heavy cases × 3
  coverage positions, 18/18 identical. Re-run on the fixed code: ev-005.
- **Fixed (commit `9d21286`):**
  - `lock_timeout` was 5s, longer than the 3s verify write budget.
  - The backfill/data-fix double count; RED ev-004.
  - `goose down` and re-apply took ACCESS EXCLUSIVE without a timeout.
  - The MAX ran under the lock with no `statement_timeout`.
  - There was no pacing knob or off switch.
  - A sub-µs `from` cost a raw hour.
  - Tests that touch the shared state row now serialize.
- **Kept as is:**
  - The trigger rather than a forward-filling job (the reviewer's alternative).
  - Table-level autovacuum settings: long snapshots block HOT pruning and vacuum alike.
  - An old-SQL oracle in the repo: it would pin readers that are meant to change.

## Out of scope (found here, separate tasks)

- **`/v1/branch-packages/history`** (9 × 500 in 24h, `list quota deductions` timeout):
  - `ListQuotaDeductions` (`branch_package.go:977`) returns **every** `quota_history`
    deduction of the merchant or branch, with no LIMIT or date range.
  - The fast path writes one `quota_history` row per verify, so this branch adds ~590k
    rows a day.
  - This is an unbounded list, not an aggregation. The fix is a contract choice:
    pagination, or a server-side bound or grouping, together with slip-front-end
    `useBranchTabData.ts:127`, which already falls back to `[]`.
- **`/v1/admin/verifications`:** 13 × 500 at 10s (admin count path).
- **Background timeouts:** `process email alerts: iterate email alerts` (8) and
  `daily digest previous slips` (1).

## Test plan

- **Repository, PostgreSQL:**
  - Rollup reads equal hand-computed expectations, with aligned and unaligned edges,
    the UTC/Bangkok day and month boundaries and dashboard windows.
  - Whole hours are answered by the rollup: raw rows deleted with the trigger bypassed
    still count. **This test fails on the old readers.**
  - The trigger follows insert, update and delete.
  - The backfill rebuilds stale or missing hours, skips gaps, waits for quiet hours and
    is idempotent.
- **Migration:** 065 up, re-run, down, and the `TestGooseSQLFiles` count. That count
  was already wrong on main: 64 files, test said 63. Fixed in the same change.

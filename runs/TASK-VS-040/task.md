# TASK-VS-040: slip-api admin verification counts time out with channel filter: drop redundant COALESCE + (channel,status,created_at) index

- Type: performance / production bugfix (slip-api only; schema change = one new index)
- Created: 2026-10-17 by a Claude side session for the conductor session, at operator request.
- Gates: preset `production`.
- Origin: TASK-VS-031 (SlipsManage calls one status-counts endpoint; on prod slip-api f1ff0df /
  slip-admin 7c0eedb). Index pattern from TASK-VS-027 (migrations 061/062); flake lessons from
  TASK-VS-032.
- Supersedes TASK-VS-030 (opened 2026-10-16, never implemented, run dir never committed): its whole
  predicate scope (`COALESCE(channel, 'api')` → `channel` in WHERE clauses) is done here, plus the
  index VS-030 did not have. VS-030 should be closed as superseded by the conductor/operator.

## Problem and evidence

Prod 2026-10-16 19:14:13–19:14:23Z: `GET /v1/admin/verifications` and
`GET /v1/admin/verifications/status-counts`, 4× each, HTTP 500 after ~10,001 ms
(`count verifications: timeout`, `count verifications by status: timeout`). Unfiltered calls take
23–35 ms (they use the closed-day status cache); any channel filter goes to the uncached
`CountAll` / `CountAllByStatus`.

`adminVerificationWhere` filters `COALESCE(channel, 'api') = $n`. `channel` is
`TEXT NOT NULL DEFAULT 'api'` + CHECK (migration 011; NOT NULL confirmed on prod, VS-027 grids
08/09), so the COALESCE is a no-op that no index can serve, and no index leads with `channel`
for platform-wide counts → every row of the ~4.4M-row / 4.3 GB table is read.

## Scope

slip-api `internal/repositories/verification.go`, WHERE clauses only (SELECT / GROUP BY
projections unchanged):
- `adminVerificationWhere` and `verificationHistoryWhere`: `channel = $n`
- `CountLineSources`, `LineDailySummary`: `channel = $2`
- `MonthlyUsageByUser`: `channel IN ('api', 'line')`

Migration 063 `verifications_channel_status_index.sql`:
`CREATE INDEX CONCURRENTLY IF NOT EXISTS verifications_channel_status_created_idx ON
verifications (channel, status, created_at)`, NO TRANSACTION, INVALID-only drop guard, Down
`DROP INDEX CONCURRENTLY IF EXISTS` — same pattern as 061/062.

Out of scope: dropping any index, autovacuum tuning, SlipsManage date bounds.

## Acceptance

- Plan regression test: channel-filtered platform-wide count and status counts are answered by
  `verifications_channel_status_created_idx` with no residual Filter; seen failing first.
- Migration tests: INVALID leftover rebuilt, VALID leftover kept (as 061/062).
- Existing plan test for scoped counts still holds with the new index present.
- Full suite on local PG 18.3 with both test DSNs, race, vet, `go build -mod=readonly`.
- Staging: SlipsManage with a channel chip returns 200; production: same after deploy.

## Deploy order and rollback

See the PR. Migration builds at boot before the listener (goose), CONCURRENTLY, no table lock.
Rollback = revert the code commit and redeploy; the index may stay (harmless) or be dropped with
the Down statement.

## Production acceptance attempt (2026-10-16 20:31–20:32Z, operator)

Clicks (operator): ทั้งหมด → API → LINE → API → Manual → ทั้งหมด, no shop selected.
slip-api prod 0e33df5 logs: unfiltered 25–38 ms; API 669/836 ms and 679/1,044 ms;
1–6 ms pairs (likely Manual); **one pair (started ~20:31:49, matching the LINE click) 500 at
10,001 ms** (`count verifications: timeout`, `count verifications by status: timeout`).
Channel filtering is mostly fixed (10 s → ≤ 1.1 s), but LINE timed out. Hypotheses: the
prepared-statement generic plan for `channel = $1` (pgx caches statements per connection;
after 5 executions PostgreSQL may use a plan that ignores the value) or a LINE row estimate
error. `explain-channel-line-prod.sql` (read-only) compares literal vs forced-generic plans.
production_acceptance stays pending.

## Close-out (2026-10-17, operator decision)

Closed as done without a re-test. Channel filters on prod: API 0.67–1.04 s (was a 10 s
timeout), Manual/LINE-sized loads 1–6 ms. **Unexplained event:** one list + status-counts
pair timed out at 10,001 ms (started ~20:31:49Z, matching the LINE click). Prod read-only
EXPLAIN (ev-016) could not reproduce it: LINE has 18 rows; literal plan 0.05 ms, forced
generic plan 5.3 ms, both on `verifications_channel_status_created_idx`, no seq scan.
RDS CPU 4–5 %, 70 connections at the time; no other count timeout through 21:23Z (ev-017).
pg_stats for `channel` lists only 'api' (LINE too rare to sample); refreshes with autovacuum.
If it recurs, capture the request time and query shape, then re-check locks/plans.
Follow-ups (review nits): run_test.go full column-list check; plan-test relallvisible at
0.85 × relpages and comment; shop + channel remains a seq-scan shape.

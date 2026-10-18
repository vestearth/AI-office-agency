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
At this attempt, production_acceptance remained pending; see the later operator close-out below.

## Close-out (2026-10-17, operator decision)

Closed as done without a re-test. Channel filters on prod: API 0.67–1.04 s (was a 10 s
timeout), Manual/LINE-sized loads 1–6 ms. **Unexplained event:** one list + status-counts
pair timed out at 10,001 ms (started ~20:31:49Z, matching the LINE click). Prod read-only
EXPLAIN (ev-016) could not reproduce it: LINE has 18 rows; literal COUNT 0.051 ms on
`verifications_branch_line_source_created_idx`, forced generic COUNT 5.301 ms on
`verifications_channel_status_created_idx`, no seq scan.
RDS CPU 4–5 %, 70 connections at the time; no other count timeout through 21:23Z (ev-017).
pg_stats for `channel` lists only 'api' (LINE too rare to sample); refreshes with autovacuum.
If it recurs, capture the request time and query shape, then re-check locks/plans.
Follow-ups (review nits): run_test.go full column-list check; plan-test relallvisible at
0.85 × relpages and comment; shop + channel remains a seq-scan shape.

## Status reconciliation (2026-10-17 05:48 ICT)

Retained the existing operator-accepted `done`; this reconciliation does not add a new
acceptance judgment. Fresh read-only evidence: **ev-018 (TASK-VS-040)**.

- GitHub confirms PR #79 merged into main as `512da6b`. Current main `512da6b`, staging
  `656231a`, and prod `0e33df5` all contain the merge. Deploy STAGING run `38959691622`
  and Deploy PRODUCTION run `38961070330` both completed successfully.
- Live ECS: staging `slip-api-staging:138`, desired/running 1/1; production
  `slip-api-production:97`, desired/running 3/3; both COMPLETED, pending 0.
- Production access-log window 2026-10-17 03:28:42–05:48:38 ICT: pagination exhausted
  (2 pages, 20 unique events). Each of list and status-counts has 9 HTTP 200 responses
  (max 805 / 1,044 ms) and 1 HTTP 500 response at 10,001 ms. The two 500s are the
  previously recorded pair at 03:31:59 ICT; its exact channel is not established by
  these access logs.
- There were **no new matching requests**, including successes, after the prior check
  at 04:23:57 ICT. Absence of additional failures is not a fresh acceptance sample.
- Existing evidence artifact hashes verified (ev-001 through ev-017). Historical test
  results were inspected; the Go suite and authenticated UI were not rerun. No database
  query, deployment, or runtime mutation was performed in this reconciliation.
- Plan clarification: the literal LINE queries use the partial
  `verifications_branch_line_source_created_idx`; forced generic LINE queries use
  `verifications_channel_status_created_idx`. The historical gate narrative is retained;
  this clarification follows the captured raw plans.

Remaining follow-ups: capture request time and complete filters if the timeout recurs;
the existing review nits and shop + channel query shape remain follow-ups.

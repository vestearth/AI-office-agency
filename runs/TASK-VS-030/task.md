# TASK-VS-030: Admin and LINE verification filters: plain channel = $n so channel indexes apply

- Type: performance / bugfix (slip-api only, no migration)
- Created: 2026-10-16 by the Claude conductor lane at operator request. Claude opens
  this run only; implementation goes to another lane.
- Gates: preset `production`.
- Follow-up of TASK-VS-027 (scoped COUNT indexes 061/062). Not related to TASK-VS-028
  (KBank 8500 retries) or TASK-VS-029 (PII in 409 logs): different files.

## Problem

`verifications.channel` is `TEXT NOT NULL DEFAULT 'api'` with
`CHECK (channel IN ('api','line','manual'))` (migration 011; confirmed on prod
2026-10-16, TASK-VS-027 `vs027-followups-prod-results.md` grids 08/09). So
`COALESCE(channel, 'api')` is a no-op, but it stops the planner from using the channel
indexes from 011: `verifications_branch_channel_created_idx`,
`verifications_user_channel_created_idx` and the partial
`verifications_branch_line_source_created_idx` (`WHERE channel = 'line'`).

Prod plain EXPLAIN (same results file, grids 11/12), dominant branch + `line`:
- `COALESCE(channel,'api') = 'line'` → Parallel Seq Scan over the 4.3 GB heap (cost 579k);
- `channel = 'line'` → Index Only Scan on the partial line index (cost 5.9).
Estimated plans only, no timings. The same seq-scan class caused the 23 s cold COUNT that
TASK-VS-027 fixed.

Reachable from:
- slip-admin SlipsManage when an operator picks a channel chip together with a shop/branch
  filter (SlipsManage.vue:21, 86-88, 157-160 on slip-admin origin/prod f28053b); any
  channel filter routes to the uncached `CountAll` (reports_summary.go:30-31).
- LINE bot paths `LineDailySummary` / `CountLineSources` (line_webhook.go:722, 793;
  reports.go:1188).
- User history filters (`verificationHistoryWhere`).

## Scope

In slip-api `internal/repositories/verification.go` (line numbers at origin/prod 822a04f),
replace the filter predicates only:
- 784 `verificationHistoryWhere` and 813 `adminVerificationWhere`:
  `COALESCE(channel, 'api') = $n` → `channel = $n`
- 675 `CountLineSources`, 741 `LineDailySummary`: same
- 627 `MonthlyUsageByUser`: `COALESCE(channel, 'api') IN ('api','line')` → `channel IN (...)`

Leave the SELECT / GROUP BY expressions (28, 579-584, 623, 628) as they are: they do not
affect index choice. No migration, no index change, no API/contract change.

Out of scope: autovacuum insert tuning (deferred by operator 2026-10-16), dropping any
index (old `(merchant|branch, created_at)` indexes are in use: idx_scan 768/584),
SlipsManage `loadStats` all-history counts (separate candidate).

## Acceptance

- Regression test in the style of `internal/repositories/verification_count_plan_test.go`:
  a branch + channel count/filter must not plan a Seq Scan and must use a channel index.
  Seen failing on the current code first, then passing (test-integrity rule).
- Existing repository tests (channel filter results, LINE summary, monthly usage) pass
  unchanged; `go vet` and race run clean.
- Staging: one SlipsManage request with shop/branch + channel filter returns 200 with the
  same totals as before; staging EXPLAIN of the new predicate uses an index.
- Production: read-only EXPLAIN (ANALYZE) of the dominant-branch + `line` count after deploy,
  run by the operator via DBeaver (BEGIN READ ONLY … ROLLBACK).

## Deploy order and rollback

Code-only: normal slip-api deploy (staging → prod). Rollback = revert the commit and
redeploy; no database step either way.

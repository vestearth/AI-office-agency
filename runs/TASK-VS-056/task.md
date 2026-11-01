# TASK-VS-056: Admin verification COUNT timeout recurrence after VS-053

Priority: high · Type: bugfix · Workstream: backend · short_name: admin-count-recurrence

## Context

TASK B from 2026-10-29 Datadog error tracking on slip-api-production:

- `admin verification count` (~13)
- `reports request failed · GET /v1/admin/verifications · count verifications: … context deadline exceeded` (~12)
- paired HTTP `request failed`

Operator already fixed this class multiple times (indexes VS-027/040, instrumentation VS-045, day aggregates VS-031/042, hourly rollup for scoped counts VS-053 deployed prod 2026-10-28 as `production-sha-742df4f`). Recurrence after that rollout means remaining paths still hit raw COUNT within the ~10s `adminCountBudget`.

Knowledge hub (lineage + current + plan): `knowledge-base/Knowledge Base/10 Projects/VerifySlip/Admin Scoped Verification Count Indexes — 2026-10-15.md` (updated 2026-10-29). Review Queue item opened the same day.

## Code fact (current behavior)

`adminVerificationCountSQL` uses hourly rollup only when filter is scoped (merchant/branch/channel) AND both `From` and `To` are set. Unscoped, open-ended, or uncovered ranges stay raw and can still exceed 10s.

## Scope

- slip-api only (read slip-admin only to identify which UI filters produce failing requests)
- Classify recurrence from prod logs (`cache_reason`, `count_path`, `date_span_days`, `error_kind`, `filter_keys` from VS-045 instrumentation)
- Fix remaining expensive COUNT paths without raising the global timeout as the primary fix
- Failing-before regression + parity tests; build/vet
- PR into main only; no merge/deploy unless separately authorized
- Keep the knowledge-base hub note current after classify and after fix

## Out of scope

- bank verifier unavailable / SMTP / merchants one-offs
- timeout increase as sole mitigation

## Acceptance criteria

1. Prod (or retained log) sample classifies the 2026-10-29 recurrence into concrete filter shapes / `cache_reason` values; written into the task evidence and the knowledge hub.
2. At least one failing-before regression demonstrates the remaining expensive path; it passes after the fix.
3. Exact count parity preserved for any path that switches source (raw vs rollup/day aggregate) under the same snapshot rules as VS-053.
4. `go test ./...`, `GOWORK=off go build -mod=readonly ./...`, and `go vet ./...` pass in slip-api.
5. Implementation PR opened into `main` only; knowledge hub + Review Queue updated to match what was fixed vs still deferred.

## Classification (2026-10-31, prod logs, ev-001)

Source: `/ecs/slip-api-production` `filter-log-events` from 2026-10-28T04:00Z
to 2026-10-30T22:46Z, every `nextToken` page followed
(`classify-prod-count-logs.sh`). Prod is still `slip-api-production:126`
(`08c9a02`), with the same count code as `742df4f`.

| Shape (VS-045 fields) | ERROR | WARN ≥1s | Origin |
|---|---|---|---|
| `full_range_fallback` / `no_closed_days`, `filter_keys=[status,from,to]`, span 1 day, bounded | **17 deadline** | 106 (p50 3.5s, p90 10s) | slip-admin `ReportSlipVerified` per-day buckets, global scope `{}`: `status=verified&from=D 00:00+07&to=D 23:59:59.999+07`, `mapLimit` 6 concurrent, ≤62 days |
| `cache_live_tail` / `cache_used`, span 1 (last day of a multi-day range) | 0 | 3 | Same report's whole-range totals: the last day's tail is counted raw |
| `no_closed_days`, `filter_keys=[from]`, open end | 1 canceled (72 ms) | 5 (max 2.8s) | Overview `slipsApi.list({ from: today, limit: 1 })` |
| `scoped_filter`, `merchant_id,status,from,to`, 28 days | 4 deadline | 0 | **Before VS-053.** Tasks `849532da…` and `b0b13ac2…` were already logging at 03:00Z. They stopped at 04:23Z, during the PR106 rollout. Not a recurrence. |

The dashboard's "12 between 10-28 11:06 and 10-29 10:33 ICT" splits into
4 scoped errors before VS-053, then 2 + 6 of the one-day shape. After that
window: 6 more at 10-29 06:13Z, 3 at 09:45Z, and 1 canceled. Since
2026-10-29 09:45Z there were no ERRORs, but 9 slow WARNs on 10-30. The shape
is still live. The count is low only because the report was opened less.

Code path (prod `08c9a02`):
`adminVerificationCount` (`internal/core/service/reports_summary.go`) floors
`to` to its Bangkok day. For a one-day filter that gives `end == from`, so
the request takes the `no_closed_days` fallback even for a closed day. It goes
to `CountAll` → `adminVerificationCountSQL`. That function uses the hourly
rollup only when the filter is scoped
(`internal/repositories/verification_admin_counts.go`). As a result, one
platform-wide Bangkok day is a raw `COUNT(*) … status = 'verified'` over
every row of that day. The same raw read runs for the last day of a
multi-day report total, through `cache_live_tail`.

The rollup is not limited to scoped reads. Migration 065's row trigger keeps
every hour from `covered_from` onward exact, in the writing transaction. The
table also has an index on `(hour)`. The scope gate came from VS-053's chosen
scope ("Unscoped/open-ended/uncovered counts retain their raw query"). It was
not a correctness limit.

## Fix (approved by Earth 2026-10-31)

Implemented in https://github.com/SparqLab/slip-api/pull/113. The branch
is `task/TASK-VS-056-platform-count-rollup` at `e9c7497`, in worktree
`.worktrees/slip-api-vs056`. Earth approved the merge. It is merged to
`main` as `55260b8` (2026-10-30T23:45:24Z) and is not on `origin/staging`
or `origin/prod`. No deploy ran, because deploys trigger only on pushes to
`staging` and `prod`. Promotion needs Earth's explicit approval.

Evidence:
- ev-002: RED. The platform case fails with `CountAll = 1; want 6 from
  rollup`.
- ev-003: GREEN. All 61 subtests pass (63 PASS lines including the 2 parent
  tests), including the platform parity cases under every coverage mode.
- ev-008, ev-009, ev-010: on the committed SHA with a clean tree, the full
  suite passes with the repository DB, and so do
  `build -mod=readonly` and `vet`.
- ev-004 to ev-007 are the same checks run before a comment-only test edit.

The test renames are `TestScopedAdminCounts*` → `TestAdminCounts*`.

Independent review (2026-10-31, read-only reviewer lane): **approved** for
`main`. Its own RED and GREEN reproduction and full suite agree.

- Warning: on synthetic data the platform-wide rollup arm read about 1.75×
  the pages of an index-only raw count, and was still faster (131 vs
  256 ms). Prod raw is not index-only (about 446k heap fetches are recorded
  for the 2026-10-15 global plan), but the prod raw-to-rollup row ratio is
  unmeasured.
- Required before promotion: read-only on prod, measure
  `SUM(verification_count)/COUNT(*)` for one report day, and run
  `EXPLAIN (ANALYZE, BUFFERS)` of the old and new query. Because the teammate
  promotes main → prod directly, do this before merge.
- Suggestions: platform parity for the reversed, empty and one-hour shapes; a
  rollup-columns comment on `adminVerificationWhere`; and `count_path` still
  reads `full_range_fallback` when the rollup answers.

Prod read-only measurement (ev-011, 2026-10-31 06:43 ICT, approved by Earth).
It ran through ECS Exec on `slip-api-production:126` task `9eee4e1a…`, in a
`BEGIN READ ONLY` transaction with `statement_timeout` 20s. The scripts are
`prod-readonly-psql.py` and `prod-platform-day-plan.sql`. The bucket measured
is one platform-wide verified day, 2026-10-29 Bangkok.

- `covered_from` = 2026-09-25 03:00Z, so the measured day is covered. Report
  days before that stay raw, the same as today.
- Rollup for that day: 25 verified rows standing for 387,804 verifications,
  about 15.5k raw rows per rollup row. Across all statuses it is 74 rows
  for 405,417. The reviewer's 1.75× page concern assumed about 4.4 rows per
  rollup row, which does not match prod.

| query | buffers (hit+read) | heap fetches | execution |
|---|---|---|---|
| old raw (custom plan) | 14,674 (11,145 + 3,529) | 13,935 | 180 ms |
| new (custom plan) | 635 (468 + 167) | 646 (last hour) | 10.4 ms |
| new (generic plan, `force_generic_plan`) | 630 | 646 | 4.5 ms |

- The rollup arm uses `verification_usage_hourly_hour_idx`, a bitmap scan
  over 26 heap blocks. The raw last hour uses
  `verifications_channel_status_created_idx`, index-only.
- Parity in one statement: old_raw 387,804 = new_rollup 387,804.
- The old query took 180 ms at this quiet hour. The prod deadlines happened
  under daytime load with 6 concurrent buckets. The fix reads about 23× fewer
  pages per bucket, but no daytime run under load was measured.

Proposal as approved:

Drop the `scoped` condition from the rollup gate in
`adminVerificationCountSQL`. Every bounded `from`/`to` count, platform-wide
included, then reads whole covered hours from `verification_usage_hourly`.
Only the edges and uncovered history read raw. The UNION stays one statement
snapshot, as in VS-053. No timeout, schema or service change.

- Effect: a one-day global bucket reads 23 rollup hours plus one partial raw
  hour (`[23:00, 23:59:59.999]`), instead of the whole raw day. The
  `cache_live_tail` last day gets the same split. The rollup arm never reads
  more rows than the raw rows it replaces.
- RED test: extend `TestScopedAdminCountsReadWholeHoursFromRollup` with a
  platform-wide case (no merchant/branch/channel, bounded hour). Raw rows are
  deleted while their rollup rows are kept. Today's code returns only the
  other fixture's raw row.
- Parity: add platform-wide and platform+status cases to
  `TestScopedAdminCountsMatchRawAcrossCoverageAndBoundaries`, across
  coverage none/full/partial/after.
- Deferred: the open-ended `from`-only Overview count. It only produced slow
  WARNs and one client cancel, never a deadline.
- Assumption to recheck before promotion: the reported days are at or after
  prod `covered_from`. Days before it stay raw, which is no worse than today.

## Staging promotion (2026-10-31, approved by Earth)

- `origin/main` `55260b8` was merged into `staging` as `2aa8738`. The
  staging→main file delta was only the two VS-056 files.
- **Procedure deviation:** the merge was pushed to `staging` directly, not
  through a `main` → `staging` PR as AGENTS.md "VerifySlip `slip-*` branch
  flow" requires. The content is the same as a PR merge would give, but there
  is no PR record. The prod step must go through a `staging` → `prod` PR.
- Deploy STAGING run 41146844477 succeeded (build-push, deploy-ecs). ECS
  `slip-api-staging:169` runs image `staging-sha-2aa8738`, 1/1, rollout
  COMPLETED, task HEALTHY. The rollback point is `slip-api-staging:168` /
  `staging-sha-1d6bb68`.
- Boot logs on the new task show only INFO lines: the gRPC and HTTP
  listeners started and the admin day caches warmed in 119 ms. No ERROR.
- ev-013: read-only parity on the staging DB for the last 7 closed Bangkok
  days, platform-wide verified. old_raw equals new_rollup every day
  (7/0/7/17/16/14/14). Staging `covered_from` is 2026-09-21 08:00Z.
  ev-012 is an earlier attempt whose output was cut off after
  `covered_from`. A later attempt hung in ECS Exec for about 11 h, was
  killed, and left no record.
- Not covered: an HTTP-level Report request on staging admin with global
  scope, which needs an admin login.

## Prod promotion PR (2026-10-31, opening approved by Earth; merge not yet approved)

- https://github.com/SparqLab/slip-api/pull/114 has base `prod` and head
  `release/TASK-VS-056-production` (`638bc4e`), cut from `origin/prod`
  `08c9a02` with `staging` `2aa8738` merged in. MERGEABLE/CLEAN.
- Scope check (verifyslip-promote step 1): `prod..staging` has only
  `e9c7497` (Sichol-Earth, VS-056), and `staging..main` is empty. Prod runs
  `production-sha-08c9a02` = `origin/prod`. No deploy run was active.
- Dry run: T1 = staging tree `f8ab299…`, T2 = `def7fc9f…`. The branch tree
  equals T2. `prod..T2` = the two VS-056 files only. The prod-only `ecs/` and
  workflow files are kept. No `migrations/` changes.
- Revisions before merge: `slip-api-production:126` 5/5,
  `slip-system-production:27` 3/3, `slip-api-staging:169`,
  `slip-system-staging:32`. Rollback means pointing the service back at
  `slip-api-production:126`.
- Remaining steps (verifyslip-promote 6–8), on Earth's approval:
  1. Merge pinned to `638bc4e` and confirm the `origin/prod` tree equals T2.
  2. Run `wait-rollout.sh` for `production-sha-<7>` with running = desired.
  3. Hash-compare env and secrets of :126 against the new revision.
  4. Check +12 min of logs: 5xx = 0 and ERROR = 0.
  5. Set `check_after` for the fix's effect, then record and commit the run.

## Prod promotion (2026-10-31, approved by Earth: "Merge and deploy")

- PR #114 was merged pinned to `638bc4e` at 13:32:30Z. `origin/prod` is now
  `7b24f3b`. Its tree equals T2. `e9c7497` and `origin/main` are both in
  `origin/prod`.
- Deploy PRODUCTION run 41206028363 succeeded. Running `wait-rollout.sh`
  gave `COMPLETED slip-api-production=slip-api-production:127:production-sha-7b24f3b:COMPLETED:5/5`.
  The deployment was created 13:34:44Z (20:34:44 ICT) and reached steady state
  at 20:43:54 ICT. Auto Scaling later set it to 3/3.
- Env and secrets of :126 and :127 have the same hashes (22 names). Only the
  image changed.
- ev-018 is the post-deploy check (`prod-promotion-check.sh`, pager
  `cwf-retry.sh`). Verdict: **PASS**. Both windows are 12 min, with every page
  read:

| window (UTC) | requests | 5xx | 5xx kind | admin 5xx | ERROR kinds | p50/p95 |
|---|---|---|---|---|---|---|
| before 13:22:44–13:34:43 | 5,893 | 194 (3.29%) | 502 `/v1/slips/verify` bank verifier unavailable | 0 | that one only | 213/787 ms |
| after 13:34:44–13:46:44 | 5,702 | 74 (1.30%) | same | 0 | same (no new kind) | 216/752 ms |

- The 5xx baseline comes from the bank verifier, not from this change. All 5
  new tasks logged `Starting slip-api HTTP`. The after window had 0
  `admin verification count` lines, but that is not proof of the fix: those
  lines only log when slow or failed, and admin traffic is low on a Saturday
  evening.
- Failed check attempts are kept as evidence:
  - ev-014 and ev-015: CloudWatch calls stalled about 10 min and failed with
    `InvalidSignatureException`. The local clock was correct (sntp offset
    0.05 s).
  - ev-016: a `read` bug in the gate. The data was the same as ev-018.
  - ev-017: `git fetch` timed out after 836 s.
- Rollback: point `slip-api-production` back at `slip-api-production:126`.
- `check_after` 2026-11-04T12:00:00Z: measure the fix's effect over business
  days with `classify-prod-count-logs.sh`, plus the traffic proof.

## Plan

1. Debugger/dev: pull recent `admin verification count` ERROR lines; tabulate filter shapes.
2. Confirm against `adminVerificationCountSQL` / `adminVerificationCount` fallback reasons which shapes still raw.
3. Implement smallest fix that removes that shape from the 10s timeout class (prefer existing rollup/day cache).
4. Tests + PR + knowledge update.

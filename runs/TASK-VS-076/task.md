# TASK-VS-076: slip-api email alerts: harden the claim job so one slow candidate cannot block every alert

Opened 2026-11-18 by a Claude conductor side session, as the F3 follow-up of
TASK-VS-075. Design first; implementation starts only after Earth approves the design.
Each promotion step (main → staging → prod) needs Earth's go-ahead.

**Status 2026-11-18:** Earth approved design B (relayed from the top session, quoting
Earth: "อนุมัติ design B ให้ session นั้นเลย"). The approval covers implementing,
testing, and opening a PR to main only. The implementation is SparqLab/slip-api#154
(`d3da8fb` tests, `5dd1dfd` fix), evidence ev-001..ev-004.

**Merged 2026-11-18T07:24:02Z:** an independent review approved at `5dd1dfd`
([PR comment](https://github.com/SparqLab/slip-api/pull/154#issuecomment-6971953834)),
then Earth said "Merge it". Merge commit `e132009` (parents `d90039b`, `5dd1dfd`; tree
`fddc52a` == PR head tree). main is 2 PRs ahead of staging (#153 tests only, #154).
Not on staging or prod: each promotion step waits for a separate go-ahead from Earth.

## Why

From 2026-11-17 09:17Z, prod sent no alert email for about 20 hours (TASK-VS-075).
One slow `quota_history` lookup inside the claim SELECT went past the shared 3 s
`queryTimeout`. The whole claim transaction then rolled back, every minute, on every
task. VS-075 fixed that query (slip-api `5b1ea17`, prod `slip-api-production:157`).
The structure that let one row block everything is still there. Earlier episodes
with the same signature: 10-18, 10-25, 11-08, 11-11.

## Current design (slip-api `origin/main` `23de73d`)

- `internal/repositories/email_alert.go` `ClaimDueAlerts` runs these in one transaction
  under one `context.WithTimeout(ctx, r.timeout)`:
  1. the enqueue `INSERT … SELECT` (all five alert types, `ON CONFLICT DO NOTHING`);
  2. the claim SELECT `claimDueAlertsSQL` (`LIMIT 100 … FOR UPDATE OF d SKIP LOCKED`),
     including the `stopped` LATERAL on `quota_history`. That LATERAL only feeds
     `QuotaStoppedAt` for `quota_exhausted` emails, and it has a fallback of `bp.updated_at`;
  3. one reservation `UPDATE` per claimed row, then `COMMIT`.
- `cmd/main.go`: `r.timeout` is the shared HTTP `queryTimeout = 3s`. `runEmailAlertLoop`
  gives each run 45 s, but the repository caps it at 3 s.
- `internal/core/service/email_alert.go` `RunOnce` returns on any claim error before
  sending anything.
- A timeout anywhere rolls back everything, the enqueue included. So the same candidate is
  due again next minute and blocks all five alert types.
- Smaller batches alone do not help. The claim orders by `d.created_at`, so the slow row
  lands in the first batch every time.

## Approaches considered

| | What changes | Isolates a slow row? | Cost / risk |
|---|---|---|---|
| A | Own alert timeout; enqueue committed in its own statement | No: it only raises the ceiling, and the one-row-blocks-all path stays | Smallest diff |
| **B (recommended)** | A, plus reserve before enrichment: the claim stops reading `quota_history`; the stopped-at lookup runs after the claim commits, under its own timeout, and falls back to `bp.updated_at` | Yes, for the known slow spot. A slow lookup costs one line of one email type, never the send | Small diff; contract change: the repository can return alerts together with an error |
| C | A, plus one claim transaction per candidate row, with a per-row timeout and backoff | Yes, for any per-row cost | More queries and more code. The candidate pick (100 oldest due ids) can be filled by stale pending rows and starve fresh alerts. Larger behaviour change |

Why B over C: after B, the claim reads only `email_alert_deliveries` and joins
`branch_packages`, `branches`, `merchants`, `packages`, and `users` by primary key. The
`renewal` LATERAL is served by `branch_package_events_package_type_idx` (migration
054). The only unbounded per-row cost found is the stopped-at lookup. Even after VS-075
it is bounded only by the branch's own `quota_history` rows since the package stopped, so
a busy branch with another active package can still make it slow. C pays for isolation
that the claim no longer needs.

## Proposed design (B)

1. **Own timeout.** `cmd/main.go` passes a dedicated `emailAlertQueryTimeout = 10 * time.Second`
   to `NewEmailAlertRepository`, not the shared 3 s. That budget applies to each step
   separately: the enqueue, the claim transaction, the stopped-at lookup, and each mark.
   The worst case for the first three is 30 s, which fits the 45 s run.
2. **Enqueue committed separately.** The enqueue `INSERT … SELECT` runs as its own
   autocommit statement (atomic on its own) under its own timeout, before the claim. If it
   fails, the claim still runs, so earlier pending deliveries and retries still go out. A
   claim failure no longer discards new deliveries.
3. **Reserve before enrichment.** `claimDueAlertsSQL` drops the `stopped` LATERAL and
   selects `bp.updated_at` as the stopped-at value, which is today's value for every row
   without quota history. Claim, lock, reserve, and commit stay one short transaction, with
   the same `LIMIT 100 FOR UPDATE OF d SKIP LOCKED` and the same reservation `UPDATE`.
   After the commit, one lookup query computes stopped-at for the claimed `quota_exhausted`
   rows (`WHERE d.id = ANY($1)`, a correlated `MAX` with the VS-075 branch filter). It runs
   under its own timeout. When it fails, those rows keep the `bp.updated_at` fallback.
   The rows are already reserved (+5 min) and are sent in the same run, so a slow lookup
   costs at most one attempt per alert. It no longer repeats every minute on every task.
4. **Partial results.** `ClaimDueAlerts` returns `nil` plus the error when the claim
   itself fails. Otherwise it returns the claimed alerts, together with any enqueue or
   lookup error joined (`errors.Join`). `RunOnce` sends the claimed alerts first and then
   returns the error. The loop still logs it as `process email alerts`, so the existing
   CloudWatch filter keeps working. The port comment documents this contract.

No schema change and no migration. Deploy order: code only. Rollback: revert the PR, or
roll the task definition back to the previous revision.

## Tests

Failing before (on current `main`) and passing after:

- R1 `internal/repositories/email_alert_test.go`: another connection holds
  `ACCESS EXCLUSIVE` on `quota_history`, standing in for a slow or blocked lookup and
  reusing `holdTableLocks` from `daily_digest_test.go`. Repository timeout 1 s. A due
  `quota_exhausted` delivery must still be claimed and reserved, with `QuotaStoppedAt =
  bp.updated_at`, and the returned error must report the lookup deadline. Today the claim
  SELECT blocks on the lock and returns no alerts.
- R2 `internal/repositories/email_alert_test.go`: hold `ACCESS EXCLUSIVE` on `packages`,
  which the claim joins and the enqueue does not. `ClaimDueAlerts` returns the claim
  error, yet the newly due delivery row must exist (pending, attempts 0). Today the
  rollback discards it.
- R3 `internal/core/service/email_alert_test.go` (fake repository and sender): when
  `ClaimDueAlerts` returns alerts together with an error, `RunOnce` sends them and then
  returns the error. Today it sends nothing.

One existing test is retargeted, with its coverage kept.
`TestClaimDueAlertsReadsOnlyTheAlertBranchQuotaHistory` (VS-075) runs EXPLAIN ANALYZE on
`claimDueAlertsSQL` and fails if the claim never reads `quota_history`. Under B the claim
intentionally no longer reads it. So the same assertions (the lookup reads
`quota_history`, and at most 100 rows per lookup against 2000 rows of another branch)
move to the new stopped-at lookup query. Authority: this design, once approved.
`TestClaimDueAlertsQuotaStoppedAtIsLastDeductionOfThePeriod` and
`TestClaimDueAlertsReservesDueDelivery` stay unchanged and must stay green.

## Acceptance criteria

1. R1, R2, and R3 are seen failing on `main` and passing after the change (evidence recorded).
2. All `TestClaimDueAlerts*` tests pass against local PostgreSQL 18
   (`SLIP_API_REPOSITORY_TEST_DSN`, `slip_repository_test`).
3. `go test ./...` and `go vet ./...` pass locally, or the failures are named.
   Known pre-existing failure: `migrations/TestGooseSQLFiles` expects 84 files and main
   has 85. It is not fixed here.
4. A PR to slip-api `main`. No promotion without Earth's explicit go-ahead for each step.
5. Staging and production acceptance: no `process email alerts` errors after the deploy,
   read over every CloudWatch page, and alert sends continue.

## Observations, out of scope (candidate follow-ups)

- The enqueue arms `auto_renew_failed` and `expired_forfeited` re-select every such
  package ever, every minute, on every task, relying on `ON CONFLICT DO NOTHING`.
  Their cost grows without bound. After B a slow enqueue cannot block claims, but it would
  stop new deliveries.
- A pending delivery whose condition no longer holds stays `pending` forever and is
  re-evaluated on every run. The status CHECK allows only `pending` and `sent`. Its count
  on prod is unknown (it needs DB read access).
- 100 sends through SMTP in one 45 s run can run out of time after a long outage.
  Unfinished rows retry after 5 min.

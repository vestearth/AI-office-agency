# TASK-EAR-403: Fix three staging test defects found while cutting TASK-EAR-402

Opened 2026-10-12 at operator request ("fix the three tests on staging first")
before promoting the TASK-EAR-402 prod train. Test-only changes; no runtime
code changed.

## 1. Games-Labs-Order — integration package did not compile

`tests/integration/purchase_test.go:141` still called `UpdatePaymentState`
with four arguments after TASK-EAR-352 (f5806e5) added `paymentGateway`, so
the `integration`-tagged package had not compiled since and none of its tests
(including `TestMigrationsReplayAddsNoDroppedColumns`) could run.
Fix: pass `""` (leave the gateway as is). PR SparqLab/Games-Labs-Order#81.

## 2. Games-Labs-Wallet — Postgres tests leaked a hand-built table

The repository Postgres tests closed their pool with `defer`, which runs
before `t.Cleanup`, so every DROP/TRUNCATE cleanup ran on a closed pool and
failed silently. The lifetime top-up tests left their hand-built
`payment_transactions` behind and `TestSumPlayerCoinLedgerPostgres` then
failed in migration 009 whenever it shared `WALLET_REPO_TEST_DSN`.
Fix: `t.Cleanup(pool.Close)` registered first. PR SparqLab/Games-Labs-Wallet#58.

## 3. Games-Labs-Missions — schema-drift scanner false alarm

`TestRepositorySQLResolvesAgainstFreshSchema` reported 42P01 `scores` at
`mission_plan_players.go:131`: the query is `cte + " SELECT ... FROM scores"`
with `cte` built at runtime, and the scanner recorded the literal tail alone.
Fix: skip a literal that is the tail of a `+` whose head cannot be folded (as
Sprintf-built statements are already skipped), still inspecting the head.
Resolved statements stay at 236. Because those queries are Sprintf-built and
can never be prepared by that test, a new
`TestListMissionPlanPlayersAgainstPostgres` runs count/page/detail for daily
and weekly and every sort order on a migrated schema; a misspelled column
fails it (mutation-checked). PR SparqLab/Games-Labs-Missions#143.

## Acceptance

- Each fix seen failing for the original reason before and passing after.
- Full suites green with every DB-gated test enabled; no test skipped,
  weakened or deleted.
- Merged to staging and deployed; TASK-EAR-402 release branches refreshed.

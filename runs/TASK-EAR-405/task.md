# TASK-EAR-405: Carry each game round's real wallet currency onto round events

Follow-up to TASK-EAR-390, opened 2026-10-12 at operator request (option (a):
ship provider attribution without currency, find the real currency separately).
Claude opens this run only.

## Problem

Every round on staging reaches the Logs projection with a blank currency, so
turnover and W/L are absent on the Game report Coin cards and on the new
per-player Provider tab (TASK-EAR-390 shows round counts only). Stamping
`Currency = "COIN"` on every round is wrong: dev-2's TASK-EAR-390 check
(2026-10-12, `runs/TASK-EAR-390/dev-2-output.yaml`) found

- Game's `SettleRoundRequest` handler and `RoundLifecycle` carry no currency
  and `settledRoundLifecycle` validates no wallet rail;
- Provider's Sigma `ArcadeSettle` calls Game `SettleRound` after `walletOp`,
  which only returns a balance and defaults the request currency to THB — no
  COIN wallet settlement happens there;
- Provider's GGSoft path forwards currencies other than THB unchanged to
  Wallet and can call `SettleRound` at round end.

## Goal

Each round event carries the currency of the wallet movement that actually
paid the bet and the win, taken from where that movement is decided
(Provider/Wallet), never assumed. A round whose currency cannot be proven
keeps a blank currency, which the reports already treat as absent.

## To decide first (pm)

- Where the authoritative currency lives per provider path (Wallet ledger
  entry, Provider request, or provider config) and how it reaches Game's
  `SettleRound` (new request field vs Game looking it up).
- Whether Sigma arcade rounds are money rounds at all, or should be excluded
  from turnover.
- Contract change in shared-lib (`SettleRoundRequest`, `PlayerActivityEvent`
  already has `Currency`), deploy order Provider → Game → Logs, and whether
  history is backfilled.

## Acceptance (draft)

- A test per provider path proves the round event's currency equals the
  currency of the wallet movement for that round.
- Rounds with no provable currency stay blank, never defaulted.
- After deploy, Game report Coin cards and the TASK-EAR-390 Provider tab show
  turnover only for rounds whose currency is COIN.

## Status reconciliation — 2026-10-26 (Codex)

Implementation and staging deployment are complete; retain `in_review` because
`authenticated_staging` has no recorded acceptance sample. The earlier
`dev-output.yaml` is a pre-merge handoff, not the current publication status.

Verified directly with GitHub on 2026-10-26:

- shared-lib [PR #97](https://github.com/SparqLab/shared-lib/pull/97) merged to
  main as `1bd040a6cd089640e8c01aeae7d79855d2291597`.
- Game [PR #50](https://github.com/SparqLab/Games-Labs-Game/pull/50) merged to
  staging as `ad824ca6136207044a84f5762b1e1a447254a51f`;
  [Deploy STAGING run 39989912353](https://github.com/SparqLab/Games-Labs-Game/actions/runs/39989912353)
  concluded success for that exact SHA.
- Provider [PR #43](https://github.com/SparqLab/Games-Labs-Provider/pull/43)
  merged to staging as `233baf0e0018705533fb05d0a9a80ea2466b3a74`;
  [Deploy STAGING run 39990838862](https://github.com/SparqLab/Games-Labs-Provider/actions/runs/39990838862)
  concluded success for that exact SHA.

Remaining closure condition: record one post-deploy real COIN round on staging
and correlate its wallet currency with the same round in
`monitoring_round_outcomes` (`currency = 'COIN'`). The gate remains pending;
missing acceptance evidence is not proof of a runtime defect. No authenticated
round, database query, fresh test suite, or live ECS inspection was performed in
this reconciliation. Sigma remains blank and historical backfill remains out of
scope, as decided in `pm-output.yaml`.

Commands: `gh pr view` for all three PRs; `gh run list --branch staging` for
Game and Provider. Current Provider adapter, Game event builder, and migration
034 were also inspected for the currency path. No completion gate was waived.


## Read-only runtime follow-up — 2026-10-26

AWS profile vestearth identity matched the required account/operator. Current
staging services are steady1/1 with completed rollouts: Game81, Provider34,
Logs63 and Wallet79 (recorded command ev-001). No deployment/scale/RDS action.
Actual Logs ClickHouse address/database was compared to DBeaver's existing
`gameslabs` connection; Game/Wallet PostgreSQL host/database matched the
checked `aws-ez2-postgres` datasource. Credential values were not copied or
written. The PostgreSQL datasource previously used for admin_actions is not
the ClickHouse datasource; they were verified independently.

Authenticated DBeaver SELECT results (manual UI evidence, not ev-NNN records):
- ClickHouse gameslabs.monitoring_round_outcomes FINAL, readonly1, max5s and
  max_rows_to_read1000000: total2714 normalized round rows; currencyCOIN rows0;
  latest occurred_at2026-10-21 02:29:03 UTC; rows after the Provider deploy
  cutoff2026-10-23T17:00:21Z =0; post-deployCOIN rows0. First bounded candidate
  query also returned no COIN rows. Screenshot
  /tmp/ear405-clickhouse-round-coverage.png.
- Staging PostgreSQL gamelabs in an explicit READ ONLY transaction, timeout5s:
  round_lifecycles3255 rows, latest settled_at2026-10-21T02:29:03.670Z,
  post-deploy rows0 and post-deployCOIN rows0. wallet_transactions10945 rows,
  latest created_at2026-10-21T02:29:04.133Z, post-deploy rows0 and post-deploy
  coin_before<>coin_after rows0. Screenshot
  /tmp/ear405-staging-source-coverage.png. These counts are separate datasets,
  not a reconciliation that every historical round is projected.

The SQL toolbar reopened an existing saved Script20 rather than a blank new
file. The probe was temporarily prepended and the script's existing READ ONLY
SELECTs also ran. Immediately undid that insertion, restoring the clean original
script; its ROLLBACK footer was inspected. No DML or saved script modification.

Conclusion: there is no post-deploy wallet/round sample in the checked staging
sources. This is missing acceptance traffic, not proof the currency code is
broken or that all projection paths are healthy. Keep authenticated_staging
pending and task in_review. No historical backfill or synthetic ledger/round
insert is authorized as substitute evidence.

User/QA handoff: perform one actual test COIN round on staging through a
non-paying test channel (e.g. VP/OneUp, not Sigma's no-wallet path), then supply
userID or roundID. User/QA performs the debit/settlement step. Next audit must
correlate that round's Wallet rail, Game round_lifecycles.currency and Logs
monitoring_round_outcomes.currency=COIN, then inspect the authenticated report
using a date range that excludes older unknown-currency rows.

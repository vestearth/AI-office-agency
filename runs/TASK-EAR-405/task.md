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

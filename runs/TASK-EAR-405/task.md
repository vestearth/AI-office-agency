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

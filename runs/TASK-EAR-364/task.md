> **ABORTED 2026-09-18 — do not implement.**
>
> The premise below is false. `redeemDiamond` was blanked by TASK-EAR-326 and
> then wired to real data by TASK-EAR-329, both completed 2026-09-07. Nothing
> fabricated reaches the screen. See `status.yaml` for the verification.
>
> The **Out of scope** section is still accurate and should be carried into the
> future run that wires the six coin aggregates.

# TASK-EAR-364 — Blank the last mock value in the player Summary panel

- Short name: `blank-redeem-diamond-mock`
- Type: fix / frontend
- Workstream: frontend
- Priority: medium
- Created: 2026-09-18
- Repo: `Games-Labs-backoffice`

## Goal

Make `admin/manage/player/Detail/[id].vue` free of fabricated numbers. One
value is left: the Summary panel's "Total Redeem" shows a hardcoded
`50 Diamond` for every player.

## Why now

TASK-EAR-179 (`0cdab1b`, 2026-08-13, on `main` and `prod`) blanked the six coin
aggregates to `null` and renders each as an em dash. It deliberately left
`redeemDiamond` alone, classing it as "mock because there is no API at all"
(see the comment at `Detail/[id].vue:375`).

That reasoning is now inconsistent with the panel around it. Six neighbouring
figures in the same card already show `—` for exactly the same reason. The one
value still showing a number is the one that is fabricated — the opposite of
what a reader will assume.

## Evidence

| fact | location |
| --- | --- |
| six coin aggregates set to `null` | `app/pages/admin/manage/player/Detail/[id].vue:78-83` |
| those six render `?? '—'` | same file, `:1479`, `:1502` |
| `redeemDiamond` rendered raw, no fallback | same file, `:1517` |
| mock source value `50` | `app/data/mock.ts:239` |
| "Total Redeem" Time/Point are real (point-history RPC) | `useAdminPlayerPointHistory.ts`, TASK-EAR-159 |
| no Diamond-redeem flow exists in any backend | comments at `:375` and `:483` |

## Scope

1. `redeemDiamond` follows the same null + em-dash path as its six neighbours.
2. `mock.ts:239` becomes `null` with the matching `number | null` type.
3. A regression test that fails before the change and passes after, in the
   style of `tests/playerReportUnavailableStates.test.mjs`.

Preserve the approved layout — the "Diamond" label stays, only the value
changes. Do not restyle the card.

## Out of scope

The six coin aggregates. Wiring them needs a Wallet lifetime aggregate API
(`GetPlayerWalletSummary`) and is blocked on PM. Findings from the 2026-09-18
advisory review, recorded so the next run does not re-derive them:

- `ListWalletTransactionHistory` returns raw paginated rows, not lifetime
  aggregates (`shared-lib/proto/admin/adminwalletpb/adminwallet.proto:237`).
  Summing them client-side is a no-ship: it moves a Wallet business rule into
  the Backoffice, and `source` is an open vocabulary, so any new grant path
  would be miscounted silently.
- `wallets.coin_turnover` is **not** gameplay-only. It counts positive COIN
  `DEBIT`/`BET` from every source except `admin_wallet_balance` and
  `package_purchase` (`Games-Labs-Wallet/internal/repositories/wallet.go:1137`),
  so the Missions restore-streak fee lands in it
  (`Games-Labs-Missions/internal/services/check_in_calendar_service.go:601`).
  It is a cross-check for "Played", never the source of truth.
- `wallet_transactions` has no index on `user_id` — only `pkey`, `transfer_id`
  and `provider_id`, confirmed against staging `pg_indexes`. Staging is 7,506
  rows / 2.7 MB, so a plain `CREATE INDEX` in a normal migration is fine; the
  runner wraps each pending file in a transaction, so `CONCURRENTLY` is not
  available in that lane. Measure prod before repeating the choice there.
- Wallet does **not** replay migrations on boot. It keeps a
  `wallet_schema_migrations` ledger and runs only pending files
  (`Games-Labs-Wallet/migrations/run.go:23`). The replay rule in the root
  CLAUDE.md is about Missions and Game.
- `reason` and `currency` live in `metadata` JSONB, not columns. No expression
  index is needed for a per-player lifetime aggregate — once `(user_id)` is
  indexed, the grouping happens over a small row set.
- Proposed bucket model, pending PM: `Purchased` is a controlled allowlist and
  `Free` is everything else, so `Purchased + Free = Total` holds structurally
  and a new grant source can never fall out of the total. Same shape for
  `Played` (gameplay allowlist) and `Used` (the remainder).
- Any Diamond field added later must be `optional` / a wrapper type, or a
  scalar will serialise as `0` and reintroduce this same defect.

## Deploy note

`Games-Labs-backoffice` `main` has no PR CI gate — merging to `main` deploys.
Treat merge as release.

## Acceptance criteria

- Every player shows `—` where `50 Diamond` was; no player shows a number
  that no backend produced.
- "Total Redeem" Time and Point still read from the point-history RPC and are
  unchanged.
- The regression test was observed failing before the fix.
- `npm test` passes in full.
- The Summary card layout is visually unchanged apart from that one value.

## Bucket wording settled by the operator (2026-09-18)

PM delegated the final decision to the operator. Carry these definitions, not
the earlier drafts in the conversation:

- **Purchased** = real-money package purchases **plus** diamond→coin exchange,
  counted as Purchased regardless of how the diamonds were obtained. Diamonds
  reach players from `store_package_reward`, `topup_bonus`, `vip_level_reward`
  and admin/legacy paths, so "real money only" was factually wrong and had to
  be dropped from the wording. Tracing each diamond's origin was rejected as
  unstable; the alternative is a third bucket, which changes the approved
  two-bucket layout. The operator accepted this trade-off.
  Exchange writes two rows — a DIAMOND debit and a COIN credit carrying
  `paired_currency`/`paired_amount` (`wallet.go:328-336`); the COIN credit is
  the row that counts.
- **Free** = the remainder, by construction.
- **Played** = in-game wagering only.
- **Used** = the remainder: restore-streak fee, **coin transfers to another
  player**, buy Pass, buy Avatar, buy VIP level, admin deduction. Transfer-out
  is a genuine COIN debit — `senderCoinAfter = senderCoinBefore - amount` with
  `models.TxDebit` (`wallet.go:584`, `:620`). Identify those rows by
  `metadata.direction = 'out'` / non-null `transfer_id`, **not** by
  `metadata.currency`: TransferCoin's baseMeta sets only `initiated_by`, so
  the currency key is often absent and the reader falls back to the COIN
  default.

Keep the existing UI label **Total Coins Wager**; no UX/UI copy change is
required. Its aggregate meaning is deliberately broader than gameplay wager:
`Total Coins Wager = Played + Used`, so it covers all settled COIN outflow,
including the non-game uses above. Future implementers must not interpret the
parent label as `Played` only.

Staging census 2026-09-18: real-money purchase 77 rows / 2,288,025 coin;
diamond exchange 81 / 847,578; restore streak 85 / 824; buy pass 24 / 4,043;
buy avatar 7 / 3,579; buy VIP level 5 / 250; admin deduction 22 / 3,998,552.

## Total Redeem — out of scope, and why the panel is not uniform

Verified 2026-09-18, recorded so nobody re-opens it as part of the coin work:

- **Point** is real but **does not net refunds** — `totalPoints` sums
  `abs(pointsDelta)` over the redeem reasons with no subtraction
  (`useAdminPlayerPointHistory.ts:170`). A known over-count: the Diamond
  composable's own comment calls it "a pre-existing over-count, flagged rather
  than changed here".
- **Diamond** is real and **does** net refunds, subtracting both the count and
  the amount for `refund_redemption_item`
  (`useAdminPlayerSendCoinHistory.ts:175`).
- **Time** counts Point redemptions only. Diamond keeps a separate count that
  is never merged into `totalRedeem` (`Detail/[id].vue:530`).

So two figures in one box use different refund rules and the count covers only
one of them. Real defects, but a separate decision from the coin buckets — the
PM note was reworded to keep them out of this ruling rather than open a second
front mid-question.

## PM ruling — CONFIRMED 2026-09-18

All three questions are now answered. The bucket work is unblocked.

1. **Scope** — COIN only, whole account lifetime, no date filter. Diamond and
   Point are excluded. Figures are the **net of settled transactions after
   refunds / reversals**.
2. **Diamond → Coin exchange counts as Purchased in every case**, without
   tracing where the diamonds came from. Count **only the COIN credit leg**;
   the DIAMOND debit leg is not counted. The staging population this decides —
   81 rows / 847,578 coin — is Purchased.
3. **Wager label** — keep `Total Coins Wager`; no copy change. It means
   `Played + Used`, i.e. all settled COIN outflow, not gameplay wagering alone.

Together with the earlier wording: Purchased is the controlled allowlist,
Free / Used are the remainders, so `Purchased + Free = Total` and
`Played + Used = Total` hold by construction.

### Caveat on "net after refunds / reversals" — CORRECTED 2026-09-18

**An earlier version of this section said there is no COIN reversal in the
data. That was wrong.** It generalised from VP and AFB alone. The correct
picture:

- Provider stamps every wallet call with an idempotency key of the form
  `<provider>:<action>:<key>` (`Games-Labs-Provider/utils/idempotency.go:15`,
  in place since 2026-03-27), and Wallet persists it in the real
  `idempotency_key` **column**. Actions are `bet`, `win`, `refund`, `adjust`.
- **COIN reversals exist today:** 1UP credits refunds as
  `1up:refund:<betID>` (`oneup/wallet.go:364`, TASK-EAR-186) and GGSoft as
  `ggsoft:refund:<cancelOrderID>` (`ggsoft/service.go:282`). AFB writes
  `afb:adjust:...` adjustments (`afb/service.go:594`). For 1UP the key tail is
  the bet id, so a refund can be paired back to its `1up:bet:<betID>` debit.
- VP's `rollback` action still writes nothing to the wallet
  (`vp/seamless.go:130-145`), so a VP rollback leaves its bet standing. That
  one is a genuine gap.
- `metadata.reverses_wallet_ledger_id` is still written only by
  RefundDiamond; it is not the COIN marker. For COIN, the marker is the
  idempotency key.

**Consequence.** The double-count risk described previously is not
hypothetical: a 1UP or GGSoft refund arrives through the ordinary
`/wallets/credit`, carries no reason, and would land in **Free** while its bet
stays in **Played** — unless the aggregate classifies by idempotency key.
Implement "net after refunds / reversals" via the key, not via reason strings.

**The 7,433 "markerless" gameplay rows are probably not markerless.** They
have no `source` and no `reason`, but Provider has sent an idempotency key
on every call since March. Verify with a census before relying on it (see
TASK-EAR-367).

## PM ruling D1 — game winnings (2026-09-18)

**Answer A: game wins and provider refunds are not Received.** Free is COIN
from non-game channels that is not Purchased. An earlier contradictory PM
reply (implying wins count in Free, gross) was explicitly withdrawn after the
staging split showed wins would be 73% of Free. Operator also confirmed older
rows are stored ×100. Full detail and the unit-normalisation requirement live
in `runs/TASK-EAR-367/task.md`.

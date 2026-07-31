# TASK-EAR-179 — Player Detail: close the remaining placeholder gaps

## Type

feature

## Workstream

frontend

## Priority

low

## Created

2026-07-31

## Epic

Player admin data-completion. **Re-scoped 2026-07-31 before any work started**
— see "Correction" below.

## Correction — what this task was originally, and why it changed

This run was first opened as "Wallet transaction ledger admin read API +
History tabs wiring", on the belief that `wallet_transactions` had no read API
and no category mapping. **That belief was stale by two tasks.** A source
audit on 2026-07-31 found:

- **TASK-EAR-159 (done, 4 PRs merged)** already built the whole thing:
  `AdminListWalletTransactionHistory` (Wallet repo/service/gRPC) with
  reason/currency/source filters, the api-gateway binding, and the backoffice
  wiring for **Earned → Point, Redeem → Point, and Send coin**. The category
  mapping this run was going to "draft" already exists as
  `runs/TASK-EAR-159/category-mapping-proposal.md` and is codified in code at
  `Games-Labs-Wallet/internal/repositories/wallet_history_reasons.go`
  (`EarnedReasons` / `RedeemReasons` allowlists).
- **TASK-EAR-172 (done)** backed Purchase → Special Pass / Limited Avatar from
  the `store_purchase_operations` ledger.
- **TASK-EAR-164 Phase A (done)** backed Game → Frequently played / Last
  played from `round_lifecycles` aggregates in Games-Labs-Game.

So the P1 gap this run was created to fill does not exist. Re-scoped to the
gaps that a source audit actually found still open.

## Verified state of `admin/manage/player/Detail/:id` (2026-07-31, read from source)

**Backed by a real admin API:** identity, wallet balance, VIP level +
turnover, lifetime top-up, golden pass, Purchase→Package (EAR-137),
Purchase→Special Pass + Limited Avatar (EAR-172), Earned→Point,
Redeem→Point, Send coin (EAR-159), Game→Frequently played + Last played
(EAR-164 Phase A).

**Still on the designed placeholder:**

1. **Game → Top Performance** — needs Max Coin Win + Total Wins, which exist
   in **no data source today**. `round_lifecycles.settled_amount` is turnover
   only (migration 021 says so explicitly); win/loss is collapsed inside the
   6 provider adapters before it reaches Game. **Out of scope here** — it is
   TASK-EAR-160's Phase B, a settlement-write-path epic that is blocked on
   three unanswered operator decisions at the end of
   `runs/TASK-EAR-160/game-tab-design-proposal.md`. Do not start it from this
   run; open it as its own task once those are answered.
2. **Redeem → Diamond** — deliberately mock: **no Diamond-redeem flow exists
   anywhere in the backend** (confirmed in the EAR-159 mapping proposal). This
   is a product gap, not a wiring gap. Leave as-is unless the operator says
   the flow is being built.
3. **Contact extras, device info, coin aggregates** — the header comment at
   `Detail/[id].vue:25-31` lists these as having no admin API. **Whether they
   have one now has NOT been re-verified** — that is this run's first job.

## Scope

- Included: (a) verify per-field whether contact extras / device / coin
  aggregates have a deployed admin API today; (b) wire the ones that do,
  data-source-only; (c) record the ones that genuinely need backend work as
  named follow-ups rather than silently leaving them.
- Excluded: Top Performance / win capture (TASK-EAR-160 Phase B), Diamond
  redeem, any new backend endpoint (if a field needs one, that is a follow-up
  task, not this run).

## Design constraints

- **Preserve the UX design — wire data only.** Override real fields on the
  designed placeholder; never replace or redesign a designed component. An
  un-backed section stays as designed.
- A failed loader must never leave placeholder data on screen — follow the
  EAR-144/EAR-177 per-field LoadState pattern already in this file.
- Bind `:user-id` from `playerId`, not `player.userId` (EAR-134 trap).
- If any new admin route is added by a follow-up: typed proto +
  `google.api.http` binding, separate staging-lane gateway PR, verified by
  grepping the module-cache `.pb.gw.go` and checking rolloutState=COMPLETED.

## Acceptance Criteria

- A written per-field verdict for contact extras / device / coin aggregates:
  backed-and-wired, or needs-backend with a named follow-up task.
- Any field wired renders real data for a staging player and shows the error
  state (not placeholder data) when its loader fails.
- No UI redesign; no change to sections that stay placeholder.
- The three deliberately-excluded items above remain documented on the page
  or in this run so the next reader does not re-litigate them.

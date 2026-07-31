# TASK-EAR-194 — Win capture T3: GGSoft + IDG accumulating adapters (Sigma deferred)

## Type

feature

## Priority

high

## Context

T1a/T1b/T2/T4 are live: the contract spine works end to end and the FE is
bound (first captured win proven — 1UP, Egypt Cat, maxCoinWin 100). This run
adds the two accumulating providers. **Sigma is DEFERRED by operator
decision (2026-07-31)** — its units question and the §9.1
turnover-correctness prerequisite stay parked; do not touch the sigma
package.

**READ FIRST**:
- `runs/TASK-EAR-183/win-definition-spec.md` v1.3 — §2 (mapping), **§3.1
  (the atomic-Lua accumulation contract — binds BOTH adapters in this
  run)**, §5 (presence), §6 (kill-switch).
- The GGSoft correlation probe results below — they are empirical (1,006
  real callbacks over 4 months from Logs' ClickHouse mirror) and refine the
  spec's assumptions.

## GGSoft probe findings (2026-07-31, gate cleared)

1. **Accumulator key = OrderID.** Type-3 award callbacks reuse the round's
   OrderID (14/14 observed); type-1↔type-4 OrderIDs match (150/154; misses
   are cancelled bets). OrderID is already what settle passes as RoundID
   (`ggsoft/service.go:342`). Do NOT involve SeasonID as round scope.
2. **Per-callback dedup component = `season_id`** — format
   `{order_id}_{unix_ts}`, unique per distinct callback, **stable across
   vendor retries** (observed on duplicate type-4 pairs). Use it as the txn
   distinguisher in the Lua dedup key, e.g. `ggsoft:win:{orderID}:{seasonID}`.
3. **Most rounds settle in a single type-4 with a signed net delta and no
   type-1** (754 type-4 orders vs 154 type-1). The wallet-credit-anchored
   definition already covers this: win = the positive delta actually
   credited, i.e. `max(0, type-4 Money)` — the clamp is load-bearing (453
   negative type-4 rows observed).
4. **Award series can arrive as multiple type-4s with distinct OrderIDs**
   (each settling its own money) — naturally handled: each is its own round.
   `AwardOrderIDs` confirmed audit-only (never matches a type-3 OrderID; it
   lists sibling type-4 award orders) — keep ignoring it for aggregation.
5. Max ONE type-3 per OrderID observed in 4 months — the existing
   `ggsoft:settle:{OrderID}:3` idempotency key has not been swallowing
   awards, but the new accumulation must not rely on that staying true.

## Scope — Games-Labs-Provider only (ggsoft + idg + shared bits)

1. **GGSoft** (`internal/core/services/ggsoft/`): accumulate win under the
   §3.1 contract — one atomic Lua script per callback that checks the dedup
   key (`ggsoft:win:{orderID}:{seasonID}`), and only if unseen marks it AND
   `INCRBYFLOAT`s the round accumulator (`ggsoft:winsum:{orderID}`), 7d TTL
   both. Type-3: add `max(0, Money)`. Type-4: add `max(0, Money)`, then at
   `EndRound` (the existing settle site, `service.go:340-347`) read the
   accumulated total and send it as `WinAmount` (gated on
   `config.WinCaptureEnabled("ggsoft")`), **including 0**. State loss =
   send what is known + loud log, never block wallet/settle.
2. **IDG** (`internal/core/services/idg/`): per-wager accumulation under
   §3.1 — Lua dedup on `idg:win:{wagerID}:{TransactionID}` +
   `INCRBYFLOAT idg:winsum:{wagerID}`, 7d TTL. On EVERY IntegratorWin
   (`callback.go:93-121`), after the wallet credit succeeds: accumulate,
   then **re-call the settle** for the same round (`round_id = WagerID`,
   same stake turnover as the original bet — recover it from the wager;
   check what state exists and extend the bet-time state if the stake isn't
   recoverable at win time) carrying the updated cumulative total as
   WinAmount. Game's NULL-preserving GREATEST makes replays and reorders
   safe. Gate on `WinCaptureEnabled("idg")`. **BonusWin EXCLUDED** —
   `IntegratorBonusWinRequest` has no WagerID (idg.go:153-163); leave that
   endpoint untouched. `RoundClosed` may be logged but must not gate the
   flow (never read today; do not start relying on vendor behavior we have
   not observed).
3. Reuse T2's plumbing: `SettleRoundInput.WinAmount`, `WinCaptureEnabled`,
   env already in ecs/env.names + workflow. No new env work expected; if a
   Lua/Redis helper deserves a shared home, follow the existing package
   layout (ggsoft's runtime.go precedent).

## Non-goals

- Sigma (deferred), VP/1UP/AFB (shipped in T2), BonusWin, any Game/
  shared-lib/gateway/FE change, prod anything.

## Acceptance criteria

- **§3.1 test matrix per adapter, RED-first**: duplicate callback (same
  dedup id twice → total unchanged), concurrent callbacks (both land —
  exercise the Lua path honestly; if the test infra fakes Redis, say so and
  cover atomicity by contract test on the script), late callback after
  settle (re-settle carries the higher total), state-loss (missing
  accumulator → send known + log, no failure), crash-mid (dedup+incr are
  one script — no state where the key is marked but the sum is not).
- Mapping tests: GGSoft type-3 + type-4 mix → Σ positive deltas; single
  type-4 negative → win 0 sent (pointer-to-0); IDG two wins 10+10 →
  re-settles with 10 then 20; zero-win rounds send 0.
- Kill-switch: unlisted → WinAmount nil, no Redis accumulation side
  effects beyond what existed before this run.
- All existing tests green (incl. T2 win_capture tests + EAR-186 refund
  tests). Full repo build/vet/test.
- PR base `main` (repo convention); body: deploy trail (merge main → bring
  to `staging` → ECS), rollout step = add `ggsoft,idg` to the staging
  `WIN_CAPTURE_PROVIDERS` variable, rollback = remove them.
- Live proof plan stated (best-effort, honest-blocked allowed): GGSoft and
  IDG callbacks need vendor auth (GGSoft JWT+MD5, IDG static API key) —
  discover from local `.env` like the 1UP harness; if secrets are absent,
  the fallback proof is unit + contract tests now and observing the first
  organic staging rounds after rollout (player-activity capturedRounds
  rising for a ggsoft/idg game).

## Out of scope

- §9.1 Sigma turnover correctness (parked with Sigma).
- ClickHouse lockdown (separate chip/task — security finding from the
  probe).

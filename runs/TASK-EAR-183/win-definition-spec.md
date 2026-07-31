# TASK-EAR-183 — Per-provider "win" definition spec (Game tab Phase B)

**Revision v1.3 (2026-07-31)** — operator addition: per-provider rollback
contract for the Provider-side changes (§6 "Per-provider rollback"); adapter
tasks (T2/T3) must ship the kill-switch env plumbing as part of acceptance.
No other change from v1.2.

**Revision v1.2 (2026-07-31) — ACCEPTED BASELINE.** Operator verdict on v1.1:
VERIFIED WITH CAVEATS — Total Wins locked to Option A (§2.1), T1a contract
publish unblocked, and two mandatory corrections folded in before T1b/T3:
(1) accumulation dedup + increment must be ONE atomic Lua script, not
SETNX-then-INCRBYFLOAT (§3.1 rule 1); (2) Game upsert must be monotonic
`GREATEST`, not last-write-wins — out-of-order cumulative totals (20 arriving
before a delayed 10) must never regress (§3, with a NULL-preserving form).
GGSoft Logs-verification note corrected: inbound rows pending confirmation
(§3).

**Revision v1.1 (2026-07-31)** — after operator review round 1 (changes
requested, 6 findings). All 6 findings were re-verified against source and
**all confirmed**; this revision folds them in. Changes from v1.0: Total Wins
semantics split out as its own locked decision (§2.1), provider-side
accumulation idempotency contract added (§3.1), IDG BonusWin excluded from v1
(§3), GGSoft round-correlation made an explicit prerequisite with an
empirical verification path (§3), `DESC NULLS LAST` + `captured_rounds`
coverage field (§6), shared-lib publish gate split T1a/T1b per AGENTS.md:275
(§6, §10), §9.1–9.2 spun to separate runs (§9).

Investigation only — no files created/modified in any target repo. All claims
carry file:line evidence; collapse formulas, the `> 0` gate, the upsert
`ON CONFLICT` clause, `reserved 6, 7`, migration shapes, and the review
findings (idg.go:153-163, ggsoft service.go:294-316, AGENTS.md:275) were
re-read directly in source.

## 0. TL;DR recommendation

**Define `win_amount` = gross round payout (total return credited to the
player for the round), ≥ 0, platform coin major units, `optional double`
(field 8) on `gamepb.SettleRoundRequest`, stored as a nullable
`DOUBLE PRECISION` on `round_lifecycles`, aggregated on-read by extending the
existing TASK-EAR-164 query — no `player_game_stats` table.** Providers
report the round's cumulative total (never a delta) built through
**idempotent per-callback accumulation** (§3.1); Game stores it
**monotonically (`GREATEST`)** — idempotent under both replay and reordering.
Reversal is free because aggregates already filter
`reversed_at IS NULL`. This deliberately revises TASK-EAR-160's
incremental-aggregate-table sketch — evidence below.

## 1. Where the win exists today — per-provider evidence (Q1–Q5)

The uniform fact: **all six adapters pass a stake-derived value into
`SettledAmount` and discard the win.** `SettleRoundInput` has no win field
(`Games-Labs-Provider/internal/adapters/gameadt/settle_round.go:15-23`), and
the wire mapping drops zero/negative amounts entirely
(`settle_round.go:106-108`: `if in.SettledAmount > 0`).

| | Win source (file:line) | Form | Collapse point (turnover formula) | Settle-layer dedup | Reversal to Game |
|---|---|---|---|---|---|
| **VP** | `WinAmt float64` — `models/providers/vp/vp.go:128`; read `services/vp/seamless.go:86` | single scalar per round (betNSettle carries bet+win together); `JackpotWin` (:129) never read | `vp/turnover.go:5-13`: `ValidBetAmt ?? ActualBetAmt ?? 0` — WinAmt computed for wallet net then thrown away | none (wallet key only, `seamless.go:236,255`) | `rollback` action is a **no-op** (`seamless.go:123-140`) |
| **1UP** | `Win int64` — `models/providers/1up/oneup.go:84` (+ `WinList` :85, never read); wallet-credited in full `oneup/callback.go:79-83` | single authoritative total per betID | `oneup/turnover.go:10-18`: `MinorToMajor(req.Bet)` ?? cached bet | **yes** — Redis SETNX 7d (`oneup/wallet.go:173-201`), rollback-on-failure `callback.go:67-72` | `/bets/refund` credits stake back but **never calls TryReverseRound** (`callback.go:101-142`) |
| **AFB** | sign of `Transaction.Amount` — `models/providers/afb/afb.go:152`; positive legs wallet-credited `afb/service.go:469-470` | **multiple signed legs** in one batched payout; win = Σ positive legs; `IsEnd` (:150) never read | `afb/service.go:520-537`: `ValidTurnover ?? max(tx.ValidTurnover, \|negative tx.Amount\|)` — positive legs discarded (test pins it: `service_test.go:65,83`) | none (wallet key only, `service.go:458,484`) | **no cancel route exists**; `Adjustment` (:539-630) doesn't settle/reverse and its idempotency key is time-based (:574) |
| **Sigma** | `Credit int64` — `models/providers/sigma/sigma.go:60` — **never read anywhere in the codebase** | per-leg; win may arrive as its own `/credit` callback; round end = `IsEndRound` (:65); legs carry `TxID` (:56) | `sigma/turnover.go:7-12`: `float64(tx.Debit)` else 0 | **none whatsoever** (no Redis, no store in the sigma package) | `/cancel` is a **no-op** (`sigma/service.go:53-56`) |
| **GGSoft** | `Money float64` signed delta — `models/providers/ggsoft/ggsoft.go:298`; type 3 = scatter wins, type 4 = end-round delta (`service.go:305,327-335`) | **split across up to 3 callback types per round**; no single field holds the round win; `AwardOrderIDs` audit-only (:307, `service.go:293`) | `ggsoft/turnover.go:9-19`: `req.Bet` ?? Redis-cached bet; settle only on `EndRound` (`service.go:340-347`); **type-3 wins never settle at all** | **yes** — Redis SETNX per order/type, 7d (`ggsoft/runtime.go:33-43`, keys `service.go:295,316`) | type-2 cancel refunds wallet + deletes bet state but **never calls TryReverseRound** (`service.go:256-290`) |
| **IDG** | `IntegratorWinRequest.Amount` (string) — `models/providers/idg/idg.go:117`, parsed `idg/callback.go:100`; carries `TransactionID` (:109) + `WagerID` (:115); bonus wins on a separate endpoint (:151-163) | **multiple win calls per wager** (`RoundClosed bool` idg.go:116 marks the last — never read today) + separate bonus-win calls | `idg/turnover.go:5-10`: `stake` identity — **settle fires inside IntegratorBet (`callback.go:73-79`); IntegratorWin has no settle call at all** | none (wallet key only, `idg/wallet.go:144,157`) | **the only wired reversal**: `IntegratorCancel` → `TryReverseRound` (`callback.go:142-150`), carries no amount |

Units today (Q5): VP/AFB/GGSoft send float64 major; 1UP sends int64 minor
(cents) converted via `MinorToMajor`; **all conversions are currently identity
because `utils.PerMajor = 1`** (`utils/coinminor.go:5`). **Sigma is the
outlier: raw `int64` cast with no conversion and no currency mapping**
(`sigma/turnover.go:9`, test pins `9900 → 9900`,
`sigma/turnover_test.go:9-13`) — see §7.

## 2. Definition of `Max Coin Win` (Q2) — approved with condition (review round 1)

**`win_amount` = gross round payout: the total amount returned/credited to the
player for that round, excluding the stake debit and excluding cancel-refunds.
Always ≥ 0.** `Max Coin Win` = `MAX(win_amount)` over non-reversed rounds.

Per-provider mapping:

| Provider | win_amount = |
|---|---|
| VP | `WinAmt` |
| 1UP | `MinorToMajor(Win)` |
| AFB | Σ positive `tx.Amount` over `AllTransactions()` |
| Sigma | Σ `Credit` legs for the round (idempotent accumulation, §3.1) |
| GGSoft | Σ positive type-3 `Money` + `max(0, type-4 Money)` (accumulation, gated on correlation prerequisite §3) |
| IDG | Σ regular win `Amount` for the wager (accumulation, §3.1). **BonusWin excluded in v1** — see §3 |

Why gross payout and not net (payout − stake): net goes negative, requires
bet/win leg correlation that three providers can't do in one callback, and the
UI column is literally "Max Coin Win" — the payout number. The mappings are
mutually consistent: an AFB round `{-90 bet, +60 win}` and a VP round
`{ActualBetAmt 90, WinAmt 60}` both yield 60 (VP's wallet math confirms WinAmt
is total return: `net = WinAmt − ActualBetAmt`, `seamless.go:86-100`).

To confirm with provider docs during implementation: whether VP `WinAmt` /
AFB positive legs include returned stake on push/tie rounds. Both readings map
to "total return", so `Max Coin Win` is stable either way — but push/tie DOES
change `Total Wins` counts, which is why Total Wins is now its own decision:

### 2.1 `Total Wins` semantics — locked recommendation (was under-specified in v1.0)

Review round 1 correctly rejected v1.0's framing of push/tie as cosmetic:
under gross payout, a push (stake returned) has `win_amount > 0` and would
count as a "win". Three candidate definitions:

| Option | Formula | Verdict |
|---|---|---|
| **A. Any payout** (recommended) | `COUNT(win_amount > 0)` | Uniformly computable from the one new column; no cross-field dependency |
| B. Profitable round | `COUNT(win_amount > settled_amount)` | **Rejected for v1**: `settled_amount` is NOT the stake for AFB (`ValidTurnover`, afb.go:138-141 — valid turnover ≠ actual bet) and is NULL on some rows (the `> 0` gate) — silent misclassification per provider |
| C. Provider-declared win | provider flag | **Rejected**: no such flag exists uniformly (only some providers distinguish) |

**LOCKED (operator, 2026-07-31): Option A** —
`COUNT(*) FILTER (WHERE win_amount > 0)`, definition stated in the proto
comment and the UI column tooltip ("rounds with any payout"). Push/tie rounds
are rare on a slots-dominant catalog; when a table-game provider makes this
matter, revisiting means changing one `FILTER` clause, not the schema —
`win_amount` (payout) and `settled_amount` (turnover) are both on the row, so
Option B remains computable later without recapture.

## 3. Multi-leg and late wins (Q3) — the total-not-delta rule

**Rule: a provider always reports the round's cumulative win TOTAL to Game,
never a delta. Game stores it monotonically — `GREATEST(existing, incoming)`,
never last-write-wins.** Monotonic max is idempotent under replay AND
reordering (a cumulative 20 arriving before a delayed 10 must never regress
to 10 — operator caveat, review round 2); there is no legitimate
win-decrease path in v1, because corrections are whole-round reversals
handled via `reversed_at`, not amount edits. Provider-side accumulation of
deltas is where replays corrupt, so it gets its own contract (§3.1) — v1.0
glossed over this and review round 1 was right to flag it.

- **VP / 1UP / AFB — total known in the settle call itself.** Pass it straight
  into field 8. No accumulation state, no new idempotency surface. Low effort.
- **GGSoft — PREREQUISITE: prove round correlation first.** The plan
  accumulates type-3 `Money` and reads it at type-4, but the code cannot prove
  type-3 callbacks carry the round's `OrderID` rather than their own
  award-order id: the request has both `OrderID` and `SeasonID`
  (`ggsoft.go:293-309`), and the type-3 idempotency key
  `ggsoft:settle:{OrderID}:3` (`service.go:295`) implies **at most one type-3
  per OrderID is ever processed** — if multiple scatter awards shared the
  round's OrderID, the second's wallet credit would already be swallowed
  today, so the existing code implicitly assumes distinct per-award OrderIDs.
  **Verification path available — inbound GGSoft rows pending confirmation:**
  query raw bodies from Games-Labs-Logs `provider_inbound_events` (staging)
  for `/ggsoft/seamless/verifyUserBalance` and observe real type-1/3/4
  `OrderID`/`SeasonID` groupings. Caveat (operator, review round 2):
  TASK-EAR-181 confirmed live rows only for `provider_outbound_events`
  (23,280) and explicitly did not capture the inbound count — the schema and
  publisher wiring for inbound exist, but whether GGSoft inbound bodies are
  actually present must be confirmed by the first query (if empty, fall back
  to provider docs). Until verified, correlation key = TBD
  (candidates: shared OrderID, or SeasonID as round scope) and the GGSoft
  adapter task must not start. Medium once unblocked.
- **Sigma — needs new accumulation state** (the package has zero storage
  today): accumulate each `Credit` leg per `sigmaSettleRoundID(tx)` under the
  §3.1 contract (legs carry `TxID`, sigma.go:56), send total on the
  `IsEndRound` settle (`service.go:63-65, 83-85`) and on arcade-settle (:74).
  Medium. Gated on the §7 unit decision AND the §9.1 turnover-correctness
  prerequisite run.
- **IDG — settle fires at bet time, before any win exists** (`callback.go:73`
  inside IntegratorBet). Approach **(A)**, approved in review round 1 with
  conditions, all adopted: accumulate regular win totals per `WagerID` under
  the §3.1 contract (dedup on `TransactionID`, idg.go:109); on each
  IntegratorWin, re-call `SettleRound` for the same `round_id` carrying the
  updated total (same stake turnover). The duplicate `player.activity`
  republish is harmless — Missions dedups on deterministic event ids
  (`player-activity:round:{round_id}:{type}`,
  `Games-Labs-Game/.../gamesvc/player_activity.go:97-103`; consumer dedup
  tables `Games-Labs-Missions/migrations/014, 031, 035`).
  **BonusWin is EXCLUDED from v1**: `IntegratorBonusWinRequest`
  (idg.go:153-163) carries **no `WagerID` and no `GameSessionID`** — only
  `GameID` + `BonusID` — so it cannot be attributed to a round at all.
  Consequence, stated honestly: IDG Top Performance will systematically
  exclude bonus payouts until IDG's docs reveal a linkage (revisit then; the
  wallet still credits them, so money is correct — only the stat omits them).
  Rejected **(B)** move IDG's settle to `RoundClosed=true`: changes when
  turnover lands for Missions scoring — a behavioral change to a working money
  path, not worth coupling to this feature. Medium-high.

### 3.1 Provider-side accumulation idempotency contract (new in v1.1)

Every accumulating adapter (Sigma, GGSoft, IDG) MUST implement, and its task's
acceptance criteria MUST test:

1. **Dedup + increment as ONE atomic Lua script (mandatory — operator
   caveat, review round 2)**: a single Lua script that checks the
   per-callback dedup key (`ggsoft:win:{orderID}:{txnKey}` /
   `sigma:win:{roundID}:{TxID}` / `idg:win:{wagerID}:{TransactionID}`), and
   only if unseen both marks it AND `INCRBYFLOAT`s the accumulator — in the
   same script. **Separate SETNX-then-INCRBYFLOAT commands are forbidden**:
   if the process dies between them, the retry sees the dedup key and never
   increments — a permanent, undetectable undercount. Concurrent callbacks
   must both land; read-modify-write is forbidden. (The existing
   reserve/release shape at `ggsoft/runtime.go:33-55` /
   `oneup/wallet.go:173-209` is the naming precedent only — its two-command
   structure is exactly what this rule prohibits for accumulation.)
2. **TTL**: 7 days on both dedup keys and the accumulator, matching the
   existing bet-state and idempotency precedents (`ggsoft/runtime.go:21`,
   `oneup/wallet.go:28`). Rationale: rounds are settled within minutes; 7d
   covers provider retry horizons.
3. **State loss = documented undercount, never a failure**: if the
   accumulator key is missing (Redis restart / TTL), send what is known, log
   loudly (`[win-capture] state missing`), never block the wallet or settle
   path. Win data here is a statistic, not money — the wallet rail stays
   authoritative. (Game's `GREATEST` upsert also means a post-loss lower
   total can never clobber a higher one already stored.)
4. **Required tests per adapter**: duplicate callback (same txn id twice →
   total unchanged), concurrent callbacks (both counted), late callback after
   settle (re-settle carries the higher total), state-loss path, and
   crash-mid-accumulation (kill between receipt and settle → retry converges,
   never undercounts vs the Lua-script guarantee).

**Game-side upsert change** (`Games-Labs-Game/internal/core/repositories/game.go:1531`):

```sql
ON CONFLICT (round_id) DO UPDATE
  SET win_amount = GREATEST(
        COALESCE(round_lifecycles.win_amount, EXCLUDED.win_amount),
        COALESCE(EXCLUDED.win_amount, round_lifecycles.win_amount)
      ),
      updated_at = NOW()
```

**Monotonic, not last-write-wins** (operator caveat, review round 2): a
cumulative total of 20 arriving before a delayed re-settle carrying 10 must
stay 20. The double-`COALESCE` form is deliberate — it preserves NULL
semantics: NULL + NULL → NULL (never-captured stays never-captured, NOT
coerced to 0 which §5 defines as "confirmed zero payout"); NULL + 10 → 10;
20 + NULL → 20; 20 + 10 → 20. **Mandatory regression test: settle with
win_amount=20, then a delayed settle with win_amount=10 → stored value stays
20; plus the NULL-pair case stays NULL.**

`settled_amount`, `settled_at`, `game_type` etc. stay **immutable** — the
update clause touches `win_amount` only, so turnover semantics are unchanged.

⚠️ **Implementation trap:** today `inserted` is detected by `DO NOTHING`
returning no row (`pgx.ErrNoRows` fallback, game.go:1542-1549), and the
service **deletes the row if event publish fails and `inserted` is true**
(`gamesvc/service.go:337-341`). With `DO UPDATE`, `RETURNING` always yields a
row — `inserted` must switch to `RETURNING (xmax = 0) AS inserted` or
equivalent, or a publish failure on a duplicate settle would delete a
pre-existing settled round. This needs its own regression test.

## 4. Reversal rule for the aggregates (Q4)

**Free, by keeping aggregation on-read.** `ReverseRound` sets `reversed_at`
and keeps `settled_amount` (`repositories/game.go:1572-1585`); every
aggregation query already excludes `WHERE rl.reversed_at IS NULL`
(`game.go:125-134, 166+, 222-275`). A reversed round therefore drops out of
`MAX(win_amount)` and `COUNT(win_amount > 0)` automatically — no decrement
logic, no recompute, no tombstone. This is the decisive argument for **not**
building the `player_game_stats` incremental table from 160's sketch: an
incremental `max_win_amount` cannot be decremented on reversal without a
rescan, while the read-side `MAX` never has the problem. `ReverseRound` is
idempotent (second reverse no-op, `gamesvc/service.go:436`).

Volume check: staging measured ~2 gameplay events/day (TASK-EAR-168);
TASK-EAR-164's identical GROUP BY already runs per-request in production-like
conditions. Add the missing index (§6) and revisit a materialized aggregate
only if latency ever demands it.

## 5. Zero vs absent (Q2/Q6)

A zero-payout (lost) round must be distinguishable from "win not captured":

- Proto: `optional double win_amount = 8;` — proto3 explicit presence;
  `optional` is already in use in this proto tree
  (`admingamepb/admingame.proto:372,459-460`), so buf codegen is proven.
- Adapter: `WinAmount *float64` on `SettleRoundInput`; set whenever known,
  **including 0** — do NOT replicate the `> 0` gate at
  `settle_round.go:106-108` for the new field.
- Column: `NULL` = not captured (legacy rows, provider not yet widened);
  `0` = confirmed zero payout. Mirrors `settled_amount`'s documented NULL
  semantics (`migrations/021:5-6`).

## 6. Contract + schema changes (Q6)

**shared-lib** (`proto/gamepb/game.proto`):
- `SettleRoundRequest` (:228): `optional double win_amount = 8;` (field 8 is
  the next free number, fields 1–7 verified :229-236).
- `RoundSettlement` (:238): `optional double win_amount = 7;` (echo).
- `admingamepb/admingame.proto:436-439`: **remove `reserved 6, 7;` and declare
  the fields it was explicitly holding for this phase**, plus a coverage
  field so consumers can tell partial data from zero (review round 1, §
  partial-data finding):
  `optional double max_coin_win = 6; int64 total_wins = 7;
  int64 captured_rounds = 8;` on `PlayerGameActivityItem`
  (`captured_rounds` = rounds with non-NULL `win_amount`; `total_wins = 0`
  with `captured_rounds = 0` means "never captured", with `captured_rounds >
  0` means "played, never won").
- `events/player_activity.go`: **no change.** `PlayerActivityEvent` keeps its
  contract; win does not ride the activity rail in this phase.
- Regenerate via `make buf`.

**Games-Labs-Game**:
- Migration `032_round_lifecycle_win_amount.sql` (numbers 022–031 are taken):

  ```sql
  -- +goose Up
  ALTER TABLE round_lifecycles
      ADD COLUMN IF NOT EXISTS win_amount DOUBLE PRECISION;
  COMMENT ON COLUMN round_lifecycles.win_amount IS
      'Gross round payout (total return credited), >= 0. NULL = not captured.';
  CREATE INDEX IF NOT EXISTS idx_round_lifecycles_user_id
      ON round_lifecycles (user_id);
  -- +goose Down
  ALTER TABLE round_lifecycles DROP COLUMN IF EXISTS win_amount;
  ```

  Every statement idempotent — Game replays the full hardcoded sequence every
  boot with no version table (`migrations/run.go:53-111`), so the file must be
  added **both** as a `//go:embed` var **and** an explicit `Exec` in `Run()`.
  The `user_id` index is genuinely missing today (only the PK and
  `idx_round_lifecycles_game_id` exist, `007:14`) while every player query
  filters `WHERE rl.user_id = $1` — it also speeds up the live EAR-164
  endpoints.
- `UpsertRoundSettlement`: `DO NOTHING` → the win-only monotonic
  `GREATEST` `DO UPDATE` (§3) with the `(xmax = 0)` inserted-detection fix +
  regression tests (out-of-order 20-then-10, NULL-pair, duplicate-publish
  delete trap).
- `ListPlayerGameActivity` CTE (`game.go:222-275`): add
  `MAX(rl.win_amount) AS max_coin_win`,
  `COUNT(*) FILTER (WHERE rl.win_amount > 0) AS total_wins`, and
  `COUNT(rl.win_amount) AS captured_rounds`; new server-validated sort key
  `top_performance` with **`ORDER BY max_coin_win DESC NULLS LAST`** —
  Postgres default `DESC` puts NULLs FIRST, which would rank never-captured
  games on top (review round 1 finding; applies to any future win-sorted
  query too). The proto comment already designed sort as a free-form string
  precisely so this needs no proto change (`admingame.proto:423-425`).
- Handler/mapper: `admingamehdl/grpc.go:419-458` + model
  (`internal/models/game.go:93-102`, port `ports/repositories.go:84-90`) gain
  the three fields.

**api-gateway**: no route work, but the binary **must be rebuilt with the
bumped shared-lib** in the staging lane or the new response fields silently
never appear — this exact class has bitten four times (EAR-147/159/164/172).
Verify by curling the staging endpoint, not by green build.

**Games-Labs-Provider**: per-provider changes per §3; each provider PR is
independent and can trickle — a provider not yet widened simply keeps sending
NULL win.

**Per-provider rollback (operator requirement, 2026-07-31, v1.3):** win
capture in Provider ships behind a boot-time allowlist env —
`WIN_CAPTURE_PROVIDERS` (comma-separated provider codes, e.g.
`vp,1up,afb`; default EMPTY = capture off). An adapter sets `WinAmount` only
when its provider code is listed. Rollback for any single provider = remove
its code from the env and restart the Provider service — no code revert, no
effect on the other five, no downstream impact (the contract is optional
end-to-end). Plumbing rule from the schedule-generator lesson (TASK-EAR-079):
the env var must be added to the deploy manifests (`ecs/env.names` +
staging config), not just set in a console, or it silently vanishes on the
next deploy. Behavioral notes: (1) disabling stops NEW capture only — values
already stored keep serving, which is correct for a statistic, and Game's
monotonic `GREATEST` means a later re-enable can only raise them; (2)
accumulation state (§3.1) simply expires via its 7d TTL; (3) full code
revert stays available as the backup path. Each adapter task's acceptance
criteria include: the kill-switch honored, the env documented in the deploy
manifests, and a test that an unlisted provider sends no win field.

**Games-Labs-backoffice**: bind Top Performance tab in
`useAdminPlayerGameActivity.ts` (:80-91) / `Detail/[id].vue:493-513` to
`maxCoinWin`/`totalWins`/`capturedRounds` — **grpc-gateway emits camelCase for
typed protos** (the check-in trap, TASK-EAR-076): normalize at the composable
boundary. Display rules for partial data (review round 1): NULL
`max_coin_win` renders "-"; when `captured_rounds == 0` the row shows "-" for
both win columns (never "0"); the tab carries a "win stats since <rollout
date per provider>" annotation, or stays gated until the operator calls
rollout coverage sufficient — preserve the approved UX design, wire data
only.

**Deploy order — with the shared-lib publish gate (AGENTS.md:275)**: the
workspace rule is *"stop and ask the user to publish and bump shared-lib
first before implementing downstream service changes"*, so T1 from v1.0 is
split:

1. **T1a** shared-lib contract (gamepb field 8, admingamepb 6/7/8, `make
   buf`) → **STOP: operator publishes/tags shared-lib**.
2. **T1b** Game (go.mod bump — no `replace`, `go mod tidy`, commit
   go.mod+go.sum together, `GOWORK=off go build -mod=readonly ./...` per
   AGENTS.md:282; migration 032; upsert; query; handler) + api-gateway bump.
3. Provider adapters (any order, per-provider; each with its own go.mod
   bump).
4. Backoffice FE last.

Every step is additive; **rollback** at any point = stop deploying forward
(no step breaks a predecessor; reverting Provider just returns win to NULL
for new rounds). Prod note: this rides the staging lane; the consolidated
prod patch must carry migration 032 before any prod Provider deploy sends
field 8.

## 7. Units decision (Q5) — one genuine blocker, scoped to Sigma

Platform unit for `win_amount` = **coin major units, float64** — identical to
`settled_amount` (022/021 precedent; `PerMajor = 1` makes minor==major
everywhere today, `utils/coinminor.go:5`).

**Sigma must be confirmed against its provider docs before its adapter is
widened**: `float64(tx.Debit)` is a bare cast of a raw int64 with no currency
mapping and no minor/major conversion (`sigma/turnover.go:7-12`) — if Sigma
reports minor units, its **existing turnover is already 100× the other
providers'**, and win would inherit the same distortion. This is a
pre-existing `settled_amount` integrity question surfaced by this pass, not
created by it. Per review round 1: this is a **prerequisite scoped to the
Sigma adapter task only** — it does not block the other five providers, the
contract spine, or the FE.

## 8. Backfill (Q7) — reconfirmed: none

Stance from 160 holds. New evidence makes it slightly *more* feasible than 160
knew (wallet credit rows carry per-win sources like `1up_win_<betID>`,
`oneup/wallet.go:353`; AFB per-leg keys `afb:win:<txid>`) but still: no
`game_id` on wallet rows for most providers, per-provider source formats, and
**Sigma is impossible** — it performs no wallet calls at all (stub returning
balance 0, `sigma/service.go:100-105`). Start empty, fill going forward; UI
handles partial data per §6's display rules. Not worth reopening.

## 9. Adjacent defects surfaced (pre-existing, NOT this task's scope)

Operator decision (review round 1): **separate runs, not folded in.**

1. 🔴 **Sigma credit-only end-round settles as nothing**: a win-only
   `/credit` with `IsEndRound=true` has `Debit == 0` → turnover 0 → the
   `> 0` gate drops it → the round reaches Game with no amount
   (`sigma/service.go:83-85` + `turnover.go:8-9` + `settle_round.go:106`).
   Live turnover under-count today. **Disposition: own run, positioned as a
   prerequisite of the Sigma Phase B adapter task** (same files, same unit
   question — fix turnover correctness first, then widen for win).
2. 🔴 **1UP refund never reverses in Game**: `/bets/refund` credits the stake
   back but the round's turnover stays counted for Missions
   (`oneup/callback.go:101-142`, zero `TryReverseRound` call sites in the
   package) — and per the 1UP spec this path fires automatically on 4xx +
   15-minute retries (`docs/oneUpSpin.txt:943-947`). Hot path.
   **Disposition: own run, production-integrity fix, priority ABOVE Top
   Performance** — small scope (IDG's `callback.go:142-150` is the working
   precedent; Game's `ReverseRound` is already idempotent).
3. VP `rollback` and GGSoft type-2 cancel don't reverse in Game either
   (`seamless.go:123-140`, `ggsoft/service.go:256-290`); GGSoft is benign
   until a type-4 has settled, VP's is a silent drop. Log-only for now.
4. AFB `Adjustment` idempotency key is time-based = non-idempotent
   (`afb/service.go:574`). Log-only for now.
5. Settle-layer replay: VP/AFB/Sigma/IDG re-fire `TrySettleRound` on provider
   retries; Game's `round_id` PK absorbs inserts and event dedup absorbs
   republish, so impact is noise, not corruption — worth knowing, not urgent.

## 10. Sizing and suggested implementation split (v1.1)

| Piece | Size |
|---|---|
| T1a shared-lib proto (gamepb 8 + admingamepb 6/7/8 + regen) → publish gate | Low |
| T1b Game (bump, migration 032, upsert DO UPDATE + xmax fix, query NULLS LAST, handler) + gateway bump | Low-Medium (xmax trap needs care) |
| Provider: VP, 1UP, AFB | Low each |
| Provider: GGSoft | Medium — **gated on round-correlation verification (§3, via Logs `provider_inbound_events`)** |
| Provider: Sigma | Medium — **gated on §7 units + §9.1 prerequisite run** |
| Provider: IDG | Medium-High (late-win re-settle flow, §3.1 tests; BonusWin excluded) |
| api-gateway bump + staging verify | Low (but 4x-bitten — verify by curl) |
| Backoffice FE (incl. partial-data display rules) | Low |

Overall **Medium**. Suggested runs: **T1a** contract publish → **T1b** Game +
gateway → **T2** VP/1UP/AFB adapters → **T3** GGSoft (post-correlation) /
Sigma (post-prereqs) / IDG adapters → **T4** FE bind + staging E2E. T2/T3
adapter tasks additionally carry the per-provider rollback kill-switch
acceptance criteria (§6, v1.3). Separate tracks (§9): 1UP-refund-reverse run
(urgent, independent — opened as TASK-EAR-186), Sigma turnover-correctness
run (before Sigma T3).

## Decision status — FINAL after review round 2 (2026-07-31)

**Operator verdict: VERIFIED WITH CAVEATS. This v1.2 is the accepted
implementation baseline. T1a is unblocked; T1b/T3 are gated on the two
corrections, which are folded into §3 and §3.1.1 above.**

- [x] `Max Coin Win` = gross round payout — **approved**.
- [x] §2.1 Total Wins — **LOCKED: Option A**,
      `COUNT(*) FILTER (WHERE win_amount > 0)`, "rounds with any payout".
- [x] Read-side aggregation, no `player_game_stats` — **approved** (with
      `NULLS LAST` + partial-data display rules, §6).
- [x] IDG approach A — **approved with conditions**, all folded into §3/§3.1
      (BonusWin excluded v1, TransactionID dedup, single-Lua atomic
      accumulation, TTL + state-loss defined,
      duplicate/concurrent/late/crash tests required).
- [x] Game upsert — **monotonic `GREATEST`, NULL-preserving form; LWW
      forbidden** (mandatory 20-before-10 + NULL-pair tests).
- [ ] Sigma units — confirm with provider docs; prerequisite scoped to the
      Sigma adapter task only (does not block T1a/T1b/T2/T4).
- [ ] GGSoft round correlation — verification path via Logs
      `provider_inbound_events` available; **inbound GGSoft rows pending
      confirmation** (EAR-181 verified outbound only). Blocks the GGSoft
      adapter task only.
- [x] §9.1–9.2 — **separate runs**: Sigma turnover correctness (prereq of
      Sigma T3), 1UP refund-reverse (urgent, above Top Performance).

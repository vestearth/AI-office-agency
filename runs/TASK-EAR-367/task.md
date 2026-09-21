# TASK-EAR-367 — Player COIN summary aggregate (GetPlayerWalletSummary)

- Short name: `player-wallet-summary-aggregate`
- Type: feature / backend
- Workstream: backend
- Priority: medium
- Created: 2026-09-18
- Repos: `Games-Labs-Wallet`, `shared-lib`, `api-gateway`, `Games-Labs-backoffice`

**Read `runs/TASK-EAR-364/task.md` first.** It holds the PM-confirmed bucket
definitions, the staging census, and every trap found while scoping this.
This file only adds what is specific to the build.

## Goal

Replace the six `—` placeholders in the Detail page Summary with real,
per-player, lifetime COIN figures computed in Wallet:

| box | = | components |
| --- | --- | --- |
| Total Coins Received | Purchased + Free | |
| Total Coins Wager | Played + Used | label stays; means all settled COIN outflow |

## D1 — RESOLVED 2026-09-18: game winnings are NOT Received (answer A)

PM first sent a self-contradictory reply (headline "do not count wins",
explanation "count wins in Free, gross"). Recording was held until confirmed.
After seeing the staging split — provider win 2,160 rows / 47,298,547 coin
(73% of COIN credit), other credit 674 / 17,823,972, provider refund 18 /
1,800 — PM confirmed **A** and explicitly withdrew the earlier B wording:

- **Provider win → not in Total Coins Received.**
- **Provider refund / reversal → not in Total Coins Received.**
- **Free = only COIN received from non-game channels that are not
  Purchased.** Counting wins would have made Free ~73% game payout and buried
  the rewards and bonuses the box is meant to show.

So "Free = the remainder" now means the remainder **of non-game COIN
credits**, not of all COIN credits.

- Received = non-game COIN credits (Purchased + Free).
- Played = provider `bet` debits **net of** provider `refund` credits.
- Used = every other COIN debit.

## Units — the ×100 cut-over is NOT supported by the data (2026-09-18)

**Supersedes an earlier version of this section that made ×100
normalisation a requirement.** That version rested on the Claude lane's
inference from 18 provider refunds of exactly 100 each, set against a
test bet of 1 stored as 1; the operator confirmed it. The weekly census
of every COIN path (staging, operator, 2026-09-18) does not support a
cut-over:

- **Fixed-value rewards never change scale.** `watch_ad` is 50 in every
  week from 05-04 to 07-13. `Register Reward` is 1,000 from 04-06 to 05-04.
  `store_package_reward` sits in the same 2,400–259,875 band from 05-25 to
  08-10. A ×100 switch would show as a 100× step in these. There is none.
- **Divisibility by 100 cannot find one in gameplay.** Players bet round
  amounts. The share of multiples of 100 swings with no trend: 1UP 0% in
  05-04, then 100% in 06-29; GGSoft 0% through May, then 100% in 07-20;
  AFB 93% in 06-15, then 2% in 08-10. So the heuristic proposed earlier is
  useless.
- **The 18 refunds of 100 are refunds of 100-coin bets.** 1UP week 07-27
  has four rows, all exactly 100. That is not a unit signal.
- **Code only allows a narrow window.** Provider `PerMajor` was `100` from
  commit 763c5ed (03-24) to e8a0637 (03-26). If ×100 rows exist, they are
  Provider rows from the first data weeks (03-23 and 03-30 on staging,
  plus any deploy lag), not "older data" in general.

**Open question to the operator (Q-UNIT):** does "older rows are ×100"
mean only that March 2026 Provider window? If yes, it is staging-only test
data from before prod existed, and the aggregate should carry **no**
normalisation code — document the window rather than bake a constant into
a money figure. **Do not add normalisation until this is answered.**

## Two more findings from the same census

- **`store_package_reward` looks like the old name for a real-money
  package purchase (Q-PKG).** Its amounts match `purchase_package` exactly
  — the same 2,400 floor, the same 45,400 and 27,400 points, and a
  249,875–259,875 ceiling. It stops on 08-10 as `purchase_package` takes
  over from 08-24. The earlier split counted it as Free/other. If it is a
  purchase, **Purchased is badly undercounted**: 151 staging rows sit in
  Free. No writer for that string exists in current code or in the git
  history of Wallet, Order, Missions or User, so it was probably composed
  at runtime or written by the retired Missions local-store path. **PM or
  operator must say which bucket it belongs to.**
- **`wallet:<none>` rows are not unclassifiable noise.** They carry no
  `reason`, but for wallet-native paths the ledger `source` column holds
  the identity. For example, the free-coin grant writes
  `source = free_coin_first_login` (`models/free_coin.go`). The run of
  100-coin credits from 08-10 onward fits that. **Classify wallet-native
  rows on `reason`, then `source`**, not on `reason` alone.

## Classifier inputs

Classify on real columns first, JSON second, and never on `reason` alone —
`reason` is an open vocabulary and gameplay rows mostly have none.

| signal | where | use |
| --- | --- | --- |
| `idempotency_key` = `<provider>:<action>:<key>` | column | gameplay `bet` / `win` / `refund` / `adjust` (`Games-Labs-Provider/utils/idempotency.go:15`, since 2026-03-27) |
| `source` prefix `vp_` / `afb_` | column | gameplay, rows written after TASK-EAR-365 (PR 55, merged 2026-09-18) only |
| `transfer_id` NOT NULL / `metadata.direction` | column / JSON | transfers; do **not** filter these by `metadata.currency` — the key is often absent |
| `metadata.paired_currency` on a COIN credit | JSON | diamond→coin exchange, COIN leg only (`wallet.go:328-336`) |
| `metadata.reason` | JSON | everything non-gameplay (packages, missions, streak, pass, avatar, VIP, admin) |

Known reversal shapes for COIN: `1up:refund:<betID>` (pairs to
`1up:bet:<betID>`), `ggsoft:refund:<cancelOrderID>`, `afb:adjust:*`.
**VP rollback writes nothing to the wallet** (`vp/seamless.go:130-145`), so a
VP-rolled-back bet cannot be netted. Accept and document that; do not invent a
reversal.

## Steps

1. **Census (staging), before any SQL.** Confirm the key shapes are what the
   table actually holds:

   ```sql
   SELECT
     type,
     split_part(COALESCE(idempotency_key, ''), ':', 1) AS key_provider,
     split_part(COALESCE(idempotency_key, ''), ':', 2) AS key_action,
     COALESCE(NULLIF(metadata->>'reason', ''), '<NONE>')  AS reason,
     (transfer_id IS NOT NULL)                            AS is_transfer,
     count(*), sum(amount)
   FROM wallet_transactions
   WHERE COALESCE(NULLIF(upper(metadata->>'currency'), ''), 'COIN') = 'COIN'
   GROUP BY 1,2,3,4,5
   ORDER BY 6 DESC;
   ```

   Attach the output to this run. Anything that falls in no bucket is a
   finding, not a rounding error.

2. **Index** — new Wallet migration
   `CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_created ON
   wallet_transactions (user_id, created_at);`. Wallet's runner keeps a
   `wallet_schema_migrations` ledger and runs each pending file once, **inside
   a transaction** (`migrations/run.go:133-146`), so `CONCURRENTLY` is not
   available. Staging is 7,506 rows / 2.7 MB — a plain build is fine there.
   **Measure prod before deploying**; if it is large, build concurrently by
   hand first and let the migration be a no-op.

3. **Contract (shared-lib, publish first).** `GetPlayerWalletSummary` on
   `AdminWalletService`, `GET /api/v1/admin/wallet/summary/{user_id}`. Six
   `int64` fields. They serialise as JSON **strings** through the gateway —
   say so in the handoff. `0` is a real value here (a new player has none),
   so plain scalars are correct; failure is an error status, never a zero.
   Check `adminwallet.proto` for a `/wallet/{…}` wildcard before adding the
   route — on this gateway the **last-registered** pattern wins.

4. **Wallet** — implement the RPC with one aggregate query per player over
   the index. Tests must pin both invariants: `purchased + free = received`
   and `played + used = wager`, including with an unrecognised reason and an
   unrecognised provider prefix present.

5. **api-gateway** — its own shared-lib bump (the gateway owns the wire
   format). Prove the route with the raw response body and
   `swagger/doc.json`, not a green build.

6. **Backoffice** — wire into `Detail/[id].vue` behind a load state; on
   failure keep the `—` (TASK-EAR-179 behaviour). Preserve the approved card
   layout. Parse the six values as strings.

## Deploy order

migration → Wallet → shared-lib consumers → api-gateway → backoffice.
Backoffice `main` merge deploys immediately. Prod runs behind staging and is
cost-gated — do not scale prod to test this.

## Out of scope

- Backfilling `source` on the historical rows (TASK-EAR-365 fixed new rows
  only; the idempotency key makes a backfill unnecessary for classification).
- Making VP rollback write a reversal. Real gap, separate run.
- Total Redeem (TASK-EAR-366).
- The admin player **list** columns.

## Acceptance criteria

- D1 answered by PM and recorded here before the classifier is written.
- Census output attached; every COIN row maps to exactly one bucket.
- `purchased + free = received` and `played + used = wager` hold in tests
  and on staging for at least three real players, one of them a 1UP or
  GGSoft player with a refund.
- Route proven through the gateway by raw body and swagger.
- Backoffice shows real figures on staging, and `—` when the call fails.

## Staging evidence — 2026-09-18 (operator, DBeaver)

```
latest_any_row          2026-09-16 18:05:17 +0700
latest_provider_row     2026-09-11 09:34:42 +0700
rows_since_deploy       0        (since 2026-09-18 05:18Z)
provider_key_rows_ever  9,676
```

- **The idempotency-key classifier input is confirmed in data**, not just in
  code: 9,676 rows carry a `<provider>:…` key. That exceeds the 7,433
  markerless gameplay *debits* from the census, as it should — the 9,676 also
  counts win and refund credits. Consistent, but not yet a row-for-row proof
  that every markerless debit is keyed; step 1's census settles that.
- Staging has been idle since 2026-09-16 and has had no gameplay since
  2026-09-11. Any "zero rows since X" check on staging right now measures
  idleness, not correctness.

**Row-for-row follow-up, same day.** Markerless COIN debits (empty `source`,
empty `reason`), split by `provider_id` presence:

| has_provider_id | has_provider_key | rows | coin |
| --- | --- | ---: | ---: |
| false | **true** | 4,433 | 42,697,162 |
| true | **true** | 3,000 | 21,637,996 |

**Every one of the 7,433 markerless gameplay debits carries a provider
idempotency key**, including the 4,433 with no `provider_id`. No COIN debit
falls outside the classifier, so no PM ruling is needed for "unclassifiable
legacy rows" — that bucket is empty on staging. Do not rely on `provider_id`
as the gameplay signal; it is missing on 60% of these rows. Re-check on prod
before assuming the same.

## Two data facts learned while closing TASK-EAR-365 (2026-09-18)

- **Stored units are not what the code suggests.** A 1UP `bets/result` with
  `bet: 1, win: 1` was stored as `amount = 1` on both rows. Reading
  `oneUpWalletTransaction` (`sendAmt = amount * utils.PerMajor`) predicted
  100. Confirm units from data before summing across providers — they may
  not all agree.
- **Idempotency keys are lowercase.** `WalletKey` lowercases every part, so a
  betID sent as `…T111733Z` is stored as `…t111733z`. Match keys with
  `ILIKE` / `lower()`, never case-sensitive `LIKE`.

## Q-UNIT and Q-PKG — ANSWERED by the operator (2026-09-18)

**Q-UNIT → no normalisation code.** The ×100 rows are only the Provider
rows written by a build with `PerMajor=100` (commits 03-24 to 03-26, plus
deploy lag), not "March data" in general. The ledger has no per-row build or
version marker, so those rows cannot be identified safely. **Aggregate the
raw stored amounts** and record this as a known staging data limitation. Do
not guess a boundary.

**Q-PKG → `store_package_reward` is Free, not Purchased.** Mobile built this
reason in `rewardStorePackage` and called `/wallet/reward-package` directly.
It was a DEV direct-reward path with no payment. All 151 staging rows
(12,416,000 coin) carry `wallet-reward-package-*` idempotency and
`reference_type=store_package`. Matching the package catalog amounts shows
only that "a package's rewards were granted", not that anyone paid.
Operator's audit: `ai-dev-office/knowledge-reviews/20260918T041213Z-player-detail-summary-coin-bucket-semantics.yaml`.

That path is closed. The Wallet gRPC `RewardPackage` has required staff
permission since TASK-EAR-262 (`5b83cb1`, 2026-08-14,
`wallethdl/grpc.go:457`), and the guard is on both `origin/staging` and
`origin/prod`. The last staging row is dated 08-10, before the guard landed.
No open hole remains.

**Wallet-native classification → `reason` first, then the `source` column**
(e.g. `free_coin_first_login`). Agreed.

With these answers, every classifier input is settled. The classifier can be
written.

## Staging verification — 2026-09-18 (after Wallet :77 and gateway :119)

**Deployed:** shared-lib PR 80 (`f501126`), Wallet PR 56 (merge `27dff0c`,
`games-labs-wallet-staging:77`, log: "Migration applied:
020_wallet_transactions_user_created_idx.sql", no panic or fatal), api-gateway
PR 76 (merge `36a23a4`, `api-gateway-staging:119`). The gateway swagger
(`/adminwallet/swagger/doc.json`) lists `/api/v1/admin/wallet/summary/{userId}`.

**Probe limitation:** an unauthenticated probe cannot prove the route. The
admin auth middleware answers 401 even for a path that does not exist (control:
`/api/v1/admin/wallet/nope-does-not-exist/x` → 401). The operator ran the
production SQL itself in DBeaver instead, for QA player `f737e6f3…`:

| received | purchased | free | wager | used | played | game_debits | game_refunds |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,410,276 | 84,288 | 1,325,988 | 5,118,515 | 3,175 | 5,115,340 | 5,115,440 | 100 |

Both identities hold, played = debits − refunds, and there are no negatives.

**Still OPEN:** end-to-end proof of the route through gateway → Wallet. It
settles when the backoffice wiring is live: the six fields show numbers, not a
dash.

**Expect this question:** Wager exceeds Received by ~3.6× here, and that is
correct. Under D1, wins are not Received, but bets placed with winnings are
Played, so a player who recycles winnings wagers more than they ever received.
Tell PM before admins see it.

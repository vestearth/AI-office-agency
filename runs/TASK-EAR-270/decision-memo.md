# TASK-EAR-270 — Decision memo: where does the TopupBonus amount come from?

Author: Claude advisory lane · Date: 2026-09-01 · Status: **proposal, awaiting operator decision**

Not a commitment. Nothing is implemented. `status.yaml` is untouched
(`phase: pending`, `ready: true`) — flip it only after the decision below is locked.

---

## 1. Decision under test

Missions' `TopupBonus` pays `topup_amount * TopupBonusPercent()` as Diamond, taking
`topup_amount` **from the request body**, with nothing establishing that a top-up
occurred. TASK-EAR-263 pass 2 bound the payout to the authenticated caller, so the
ceiling dropped from "credit anyone" to "mint for yourself" — but it is still an
unbounded faucet into the caller's own wallet.

Evidence, current `origin/staging`:

- `Games-Labs-Missions/internal/handlers/mission/http/mission.go:404-435` — the
  recorded OPEN DEFECT comment and the body-decoded `TopupAmount float64`.
- `Games-Labs-Missions/internal/services/mission_service.go:562-595` — the payout:
  `bonus := topupAmount * (bonusPercent / 100.0)` then `s.wallet.Credit(...)`.
- Same function, lines 569-575: when `idempotency_key` is absent the key is
  server-generated per call, and when present it is **caller-chosen**. Replay is
  blocked, repetition is not — a fresh key per request mints again. Unlimited.
- Route is live and reachable: `internal/routes/apiv1.go:40`
  (`POST /api/v1/missions/topup-bonus`) plus the gRPC bridge at
  `internal/handlers/mission/grpc/server.go:227`.

The question is **not** how to code the fix. It is **which service owns the
authoritative top-up amount**, because no such source is wired today.

---

## 2. What changed since the run was opened (2026-08-15)

Two premises recorded in `next_action` are now stale, and one is confirmed still true.
Re-verified against source on 2026-09-01.

### 2.1 STALE (partly): "player.activity.v1 has no top-up event type"

A wallet credit event type now exists and Wallet does publish it:

- `shared-lib/events/player_activity.go:35` —
  `PlayerActivityEventTypeWalletCreditSettled = "wallet.credit.settled"`
- `Games-Labs-Wallet/internal/core/services/walletsvc/service.go:181,184` — published
  from `walletsvc.Credit()` for Diamond and Coin.

**But it does not fire for a top-up.** The settled-deposit fulfillment path writes the
credit through the repository directly, bypassing `walletsvc.Credit()` entirely:

- `Games-Labs-Wallet/internal/core/services/paymentsvc/package_fulfillment.go:40-65` —
  `s.wr.ApplyTransaction(ctx, &models.Transaction{Type: models.TxCredit, ...})`.
  No `publishWalletCreditSettled` call anywhere on this path
  (`grep -rn "publishWalletCreditSettled"` returns only `service.go:181,184`).

So option (b) is **not** "the pipe is already there". It needs a new publish at the
fulfillment point, not just a consumer.

Two further gaps in the event shape, if (b) were chosen
(`walletsvc/player_activity_publish.go:129-152`):

- `SettledAmount` is the **coin/diamond credited**, not the THB the player paid.
  The bonus base would be wrong unless a new field carries the paid amount.
- There is no deposit-vs-anything-else discriminator: `SourceReferenceType` is the
  wallet ledger row, `SourceReferenceID` the ledger id. Nothing names the
  `payment_transactions` row.
- **Loop hazard:** the bonus itself pays Diamond through `walletsvc.Credit()`, which
  *does* publish `wallet.credit.settled`. A naive Missions consumer that treats that
  event as a top-up pays a bonus on its own bonus, forever. Any (b) design must carry
  an explicit provenance discriminator — a bare event-type match is a self-feeding
  faucet, i.e. worse than today.

### 2.2 STALE (favourably): a real settlement point now exists in Wallet

TASK-EAR-297 (order-bound Stripe checkout) and TASK-EAR-298 (Stripe order settlement)
both closed `done` on 2026-08-25, PR #32 merged to Wallet `staging` at `514e1f0`.
Wallet now has one durable, order-bound place where a deposit becomes settled —
which is what option (c) would hang the payout on. That did not exist on 8/15.

### 2.3 CONFIRMED still true: `SumLifetimeTopupMinor` is declared, not implemented

- Declared: `shared-lib/proto/walletpb/wallet.proto:40,127,131`.
- `grep -rn "SumLifetimeTopupMinor" --include='*.go'` inside `Games-Labs-Wallet`,
  excluding `.pb.go`: **zero hits.** No server implementation.
- **Dormant bug found while verifying:** `Games-Labs-User` already calls it —
  `Games-Labs-User/internal/adapters/walletadt/adapter.go:129` — so
  `SumLifetimeTopup` returns gRPC `Unimplemented` today. Whoever picks option (a)
  closes this at the same time. Worth its own run if (a) is not chosen.

The evidence itself is where the comment said it is:
`Games-Labs-Wallet/migrations/009_create_payment_transactions.sql` —
`payment_transactions(user_id, provider, type, status, amount, currency, created_at)`
with `idx_payment_transactions_user_created_at` already in place, and
`models.PaymentTypeDeposit` used throughout `paymentsvc`.

---

## 3. The options

Common to all three: the client-supplied `topup_amount` becomes **inert** — kept on
the wire for compatibility, exactly as TASK-EAR-182 and TASK-EAR-262 did. And the
regression test must be seen RED first, proving a fabricated amount no longer pays.

### (a) Wallet exposes a read RPC; Missions calls it

Implement `SumLifetimeTopupMinor`, or a narrower `SumSettledDepositsSince`, over
`payment_transactions` where `type = deposit AND status = success`. Missions derives
the amount server-side and ignores the body.

| | |
|---|---|
| Repos touched | Wallet (impl), Missions (call + inert field). Proto already declared → **no shared-lib bump if the existing RPC is used**. |
| Precedent | TASK-EAR-263 pass 1 (boost gate reads Missions' own settled-turnover ledger); TASK-EAR-260 (catalog is the price authority). |
| Bonus | Repairs the dormant `Games-Labs-User` `Unimplemented` call (§2.3). |
| Loop risk | None — it is a query, not a feed. |
| **Weakness** | A *window sum* does not bind the bonus to a specific deposit. "Sum since T" still lets a player claim repeatedly against the same deposit unless Missions keeps a per-deposit claimed ledger. Idempotency key alone does not give this (§1). |
| Coupling | Synchronous Missions→Wallet at claim time; Wallet down = no bonus (acceptable — failing closed on a money path is correct). |

### (a′) Same, but per-deposit rather than per-window  ← **recommended**

Wallet exposes settled deposits as rows — `(payment_transaction_id, amount, currency,
settled_at)` — not a scalar sum. Missions claims a bonus **against one
`payment_transaction_id`**, and stores that id as the claim's natural idempotency key.

Everything in (a) applies, and the window-sum weakness disappears: one settled deposit
buys exactly one bonus, enforced by a unique constraint rather than by trusting a
caller-chosen key. Needs a new RPC (`ListSettledDeposits` / `GetSettledDeposit`) rather
than the already-declared `SumLifetimeTopupMinor`, so it **does** cost a shared-lib
bump — see §5.

### (b) Wallet publishes a deposit event; Missions consumes it into its own ledger

| | |
|---|---|
| Repos touched | shared-lib (new event type or discriminator + paid-amount field), Wallet (publish at the fulfillment path, §2.1), Missions (consumer branch + ledger), **gateway** (shared-lib pin). |
| Consistency | Matches how turnover/spend/round already reach Missions (`internal/services/activity_match.go:55-103`). |
| **Weakness** | Largest blast radius of the three, and the loop hazard in §2.1 is a real way to make this *worse* than the status quo if the discriminator is got wrong. Async also means the bonus lands after an unbounded delay — a product question, not just a technical one. |

### (c) Wallet grants the bonus at settlement; Missions stops owning the payout

| | |
|---|---|
| Boundary | Most honest — the evidence lives in Wallet, and post-EAR-297/298 there is one settlement point to hang it on (§2.2). |
| **Weakness** | Missions owns the *reward rule*, not just the payout: `config.TopupBonusPercent()`, `config.TopupBonusMin()` (`mission_service.go:566,577`) and the mission record via `s.repo.RecordMission(...)` (line 592). Wallet would have to call back into Missions or duplicate that config — duplicated money config across two services is a defect class we have already been bitten by. |
| Scope | Ownership migration, not a fix. Larger than this run. |

---

## 4. Recommendation

**(a′)** — Wallet exposes settled deposits; Missions binds one bonus to one
`payment_transaction_id` and treats the body's `topup_amount` as inert.

Why, in order of weight:

1. **It keeps the reward rule where its config and ledger already are** (Missions), and
   moves only the *fact* — did this player top up, and how much — to the service that
   owns it (Wallet). That is the boundary EAR-260 and EAR-263 both drew.
2. **It cannot pay twice**, because the claim is keyed on the deposit row, not on a
   caller-chosen string. (a)-by-window and today's code both fail this.
3. **No event-contract change across four repos**, and no loop hazard.
4. It **fails closed**: no reachable settled deposit ⇒ no payout.

Accepted costs, stated plainly: synchronous coupling Missions→Wallet on a money path,
and a shared-lib bump for the new RPC (§5). If the operator would rather avoid the
shared-lib bump entirely, the fallback is plain **(a)** using the already-declared
`SumLifetimeTopupMinor` — but then Missions **must** add a per-deposit claimed ledger
anyway, so the saving is smaller than it looks.

**Do not pick (b) without first settling the discriminator design.** A wrong one is a
self-feeding faucet, and it would look fixed.

---

## 5. Conditions that apply whichever option wins

1. **Trunk is `staging`, not `main`.** `Games-Labs-Missions` `origin/main` is at
   `80f7e67` (PR #54), roughly 20 commits behind `origin/staging` at `671d495`.
   TASK-EAR-263 (#110) and the OPEN DEFECT comment are on `staging` only.
   Branch from `staging`; PR into `staging`.
2. **shared-lib pin drift is open again** — three distinct pins across the services as
   of 2026-08-24 (`861f006` six services / `a2181ce` Order / `aca8651` Game+gateway).
   Any option that touches `shared-lib` must bump Missions **and** Wallet **and** the
   **gateway** — the gateway owns the wire format and has been the failure point five
   times. Re-run `grep shared-lib */go.mod` before starting; there are no tags, so the
   drift is otherwise invisible.
3. **Verify through the gateway, not the direct mux**, and prove it by grepping the raw
   response body — a green build is not evidence.
4. **Regression test seen RED first**, proving a fabricated `topup_amount` no longer
   pays out. Per the test-integrity rule, the failing run is recorded before the fix.
5. **No migration is expected** in Missions unless (a′) adds a claimed-deposit table —
   if it does, it ships in the same change and every statement must be idempotent,
   because Missions replays all migrations on boot.
6. The instruction from TASK-EAR-263 stands and is repeated here deliberately:
   **stop rather than invent an amount source.** A wrong source is worse than the open
   task, because it looks fixed.

---

## 6. What the operator needs to decide

One question, everything else follows from it:

> Does Missions keep ownership of the top-up bonus and ask Wallet for the deposit
> (a / a′), does it learn about deposits asynchronously (b), or does Wallet take over
> the payout entirely (c)?

Recommended answer: **(a′)**.

Open sub-question if (a′) is chosen: new RPC name and shape —
`ListSettledDeposits(user_id, since)` returning rows, vs
`GetSettledDeposit(payment_transaction_id)` with the client naming the deposit it is
claiming against. The first is friendlier to the mobile client; the second is a smaller
surface. Recommend the **first**, with Missions — not the caller — choosing which
returned row to claim.

---

## 7. As built (2026-09-01) — operator locked (a′)

Two predictions in §5 were wrong in the cheap direction, found while wiring it up:

- **No shared-lib bump, no proto change, no gateway change.** §5.2 assumed a gRPC RPC.
  Missions does not hold a gRPC client to Wallet — it calls Wallet's own mux directly
  over HTTP at `WALLET_BASE_URL` (`Games-Labs-Missions/internal/clients/wallet/client.go`,
  already reading `/wallets/balance` and `/wallets/rate-catalog/by-key` that way). The
  new read is one more mux route on the same client. And `missions.proto:135` declares
  `TopupBonus` as `google.protobuf.Struct`, so the request shape is untyped on the wire
  and existing client bodies keep parsing.
- **No migration and no new table.** `mission_logs.idempotency_key` is already UNIQUE
  (migration `001_baseline_compacted.sql:32`), and `TryRecordMission` already does the
  atomic reserve / credit / release-on-failure dance the daily streak grant uses. Keying
  the reservation on `topup:<user>:<payment_transaction_id>` gives the per-deposit
  uniqueness (a′) needs without new schema.

### Wallet — branch `feature/TASK-EAR-270-settled-deposits-read`, commit `985b8a8`

`GET /payments/settled-deposits?user_id=&since=&limit=` returns settled top-ups
(`type=deposit`, `status=success`) newest first as
`{payment_transaction_id, amount, currency, settled_at}`.

- Windowed by `updated_at`, not `created_at`: a Stripe row is created when the checkout
  opens and only reaches success when the callback settles it, so `created_at` would
  order and window by intent rather than by payment.
- Bounded: 90-day window, 50 rows.
- Mux-only, no proto binding. Verified the gateway does not route it — `api-gateway`
  proxies only `/payments/ubit-deposit-callback` and `/payments/stripe-webhook`
  explicitly (`gateway/http.go:54-55`), everything else comes from proto annotations.
  Same trust model as `/wallets/balance`. A comment on the handler says not to add a
  gateway binding: that would expose one player's deposit history to another.

### Missions — branch `fix/TASK-EAR-270-topup-bonus-server-amount`, commit `168466c`

`ClaimTopupBonus` no longer takes an amount. It reads the caller's settled deposits
from the last 7 days, takes the newest that clears `TOPUP_BONUS_MIN` and is not already
paid, reserves on the deposit id, credits, and releases the reservation if the credit
fails. Already-paid deposits are skipped rather than rejected, so a player who tops up
twice can still collect for the second. `topup_amount` and `idempotency_key` remain on
the wire, inert.

### Verification

Regression asserted through the **gRPC bridge**, the path the gateway takes, not the
direct mux — `internal/handlers/mission/grpc/topup_bonus_bridge_test.go`.

**Seen RED first**, which is the exploit itself:

```
--- FAIL: TestTopupBonusBridgeIgnoresClientAmount
    a fabricated topup_amount still paid out: wallet credited [99999.90000000001]
```

Green after the fix, all three: forged amount pays nothing; a real 500 deposit pays
exactly 50 at 10%; a fresh idempotency key against an already-paid deposit pays nothing
and returns `already_claimed`.

Full suites pass in both repos (`GOWORK=off go build -mod=readonly ./... && go test ./...`).
`git diff --check` clean; `gofmt` clean on every touched file.

### Not done — needs the operator

1. **PRs are open and awaiting merge**, both against `staging`:
   - Wallet: https://github.com/SparqLab/Games-Labs-Wallet/pull/39
   - Missions: https://github.com/SparqLab/Games-Labs-Missions/pull/116

   No `on: pull_request` CI exists in either repo, so both show zero checks and
   **merging is the deploy** to staging.
2. **Deploy order is Wallet first.** Missions' claim path calls the new Wallet route; if
   Missions ships first, `ListSettledDeposits` gets a 404 and every claim fails closed
   (no payout, no crash) until Wallet catches up. Rollback is the reverse: Missions
   first, then Wallet.
3. **Staging verification against the real services is still owed** — the tests above use
   an httptest Wallet and sqlmock, and sqlmock never reaches a driver, so the SQL in
   `ListSettledDeposits` has not been executed against Postgres. Prove it end-to-end with
   a real settled deposit and grep the raw response body.
4. **`SumLifetimeTopupMinor` is still unimplemented** (§2.3), so `Games-Labs-User`'s call
   at `walletadt/adapter.go:129` still returns `Unimplemented`. (a′) did not touch it.
   Worth its own run.

---

## 8. Runtime verification on staging (2026-09-01)

### Deploys

Merged in the required order and both green: Wallet #39 at 06:44:08Z (`49f80c4`,
Deploy STAGING success), Missions #116 at 06:47:36Z (`aaf052a`, success). Wallet's
route was live before Missions arrived, so the fail-closed window never opened.

### Route containment — PROVEN, no auth needed

Against `api-test-gateway.gameslabs.app` (`dev-api-gateway` is the dead edge, 502).
Three paths on the same `/payments/` prefix:

| path | result | meaning |
|---|---|---|
| `/payments/stripe-webhook` | 400 `webhook verification failed` | reaches Wallet, real handler answers |
| `/payments/ubit-deposit-callback` | 400 | reaches Wallet |
| **`/payments/settled-deposits`** | **404 `page not found`** | **gateway does not route it** |

The first two are the paths `gateway/http.go:54-55` proxies explicitly. The new route
sits on the identical prefix and is not reachable, so a player's deposit history does
not leak through the edge. This is the claim the handler comment makes, now evidenced.

Inconclusive and recorded as such: `/api/v1/payments/settled-deposits` returns 401, not
404. That is the gateway's auth guard on the `/api/v1/` prefix firing before routing; it
is not evidence the route exists. The 404 above is the load-bearing result.

Identity chain: a client-supplied `X-User-ID: f737e6f3` on
`/api/v1/missions/topup-bonus` gets the same 401 as no header at all — the header cannot
be forged from outside the edge.

### Live claim — PROVEN by the operator

Normal-login claim credited **79 Diamond**; immediate replay returned HTTP 200
`already_claimed` and credited **0**. CloudWatch shows `wallet.credit.settled`. The
payout followed a real settled deposit and the per-deposit key held against a replay.

### A defect this found in the (a') implementation — PR #117, `93a33f7`

`ClaimTopupBonus` reserved `int64(bonus)` into `mission_logs` but passed the **float**
`bonus` to Wallet. Wallet's `/wallets/credit` decodes `amount` as **`int64`**
(`wallethdl/wallet_handler.go`), so any deposit whose percentage is not integral would
have been rejected with 400 — the claim fails closed after releasing its reservation, so
nothing was mis-credited, but the bonus would simply never pay.

It survived the original tests because every fixture was integral: 500 at 10% is 50, and
the live acceptance deposit at 10% is 79. Truncating once and using the same integer for
the ledger, the wallet call and the response is the right shape. PR #117 merged to
staging (`a65900d`), with a regression fixture at 29 THB → 2 Diamond. Re-verified here:
full Missions build and suite pass, all four bridge tests green.

### Still outstanding

1. **The THB 29 → +2 Diamond live check.** The account used for acceptance had a
   pre-existing deposit; the 29 THB BlueStacks top-up has not been claimed against. This
   is now the *interesting* case, not a formality — it is the exact fractional path
   PR #117 fixes, and the only one proven solely by unit test.
2. **The forged-amount assertion is not yet evidenced end to end.** A 79 payout is
   consistent with the amount coming from the deposit, but the reported run did not state
   that the request body carried a fabricated `topup_amount`. Fold it into item 1: claim
   the 29 THB deposit with `"topup_amount": 999999` in the body and require **+2**, not
   +99999. That closes both in one request.
3. **Deposit currency is not checked.** `payment_transactions.currency` is constrained to
   THB or USD, and the bonus is a straight percentage of the row's `amount` regardless of
   which. A USD deposit would pay the same bonus as the same number of THB. Not a
   regression — the client's `currency` was ignored before too — but now that the amount
   is read from a real row, the currency is available and should either be filtered to
   THB or converted. Worth its own run.
4. `walletpb.SumLifetimeTopupMinor` remains unimplemented; `Games-Labs-User`'s call at
   `internal/adapters/walletadt/adapter.go:129` still returns `Unimplemented`.

### Acceptance attempt 2026-09-01T07:4x — INCONCLUSIVE, records nothing

The forged-amount claim was sent with `"user_id": "f737e6f3"` and was refused **403
`user_id does not match authenticated user`** before reaching any bonus logic. It never
exercised the fix.

Cause: `f737e6f3` is a short identifier carried in an older note, not the authenticated
UUID. `resolveOwner` (`internal/handlers/mission/http/owner.go:32`) compares the body's
`user_id` against `X-User-ID` and rejects a mismatch — the TASK-EAR-263 pass 2 guard
doing its job. The instruction to use that id came from this lane and was wrong.

The balances either side read `0 → 0`, and that also proves nothing: the wallet read was
keyed on the same short id, so an all-zero body is consistent with "no such wallet"
rather than with a verified unchanged balance. Do not record it as evidence.

**Corrected recipe — omit `user_id` entirely.** Verified in source, not assumed:
`resolveOwner` skips the comparison when the body field is empty and returns the
authenticated identity, so the token alone decides the owner:

```
curl -s -X POST https://api-test-gateway.gameslabs.app/api/v1/missions/topup-bonus \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"topup_amount":999999,"idempotency_key":"ear270-forged-29thb"}'
```

Run it with the bearer of the BlueStacks account that paid THB 29. Pass criteria:
first call `credited` with **2**, then a replay under a different idempotency key
returning `already_claimed`. That pair alone proves both properties — the amount is the
server's, and one deposit pays once — without needing the wallet balance endpoint, which
would require the full UUID in its path.

### Acceptance attempt 2026-09-01, no `user_id` — the security half is now PROVEN live

Request body `{"topup_amount": 999999, "idempotency_key": "ear270-forged-29thb"}`, no
`user_id`, bearer of the BlueStacks account. HTTP 200:

```
{"credited_coins": 0, "reward_type": "topup_bonus", "status": "already_claimed"}
```

It cleared the ownership guard and reached the bonus logic, and **a body carrying a
fabricated 999999 credited nothing**. That is the TASK-EAR-270 defect, disproven on live
staging rather than in a stub. The security property is closed.

The correctness half — a first claim paying exactly +2 on a fractional bonus — is still
only unit-tested, because this bearer's deposit had already been claimed.

**`already_claimed` was checked rather than believed, and it is truthful here.**
`TOPUP_BONUS_MIN` and `TOPUP_BONUS_PERCENT` appear in neither `ecs/env.names` nor
`ecs/task-definition.json`, so the staging task runs the code defaults of 10 and 10
(`config/config.go:211-216`; `getFloat` returns the default for an unset *or* empty
value, so the env.names empty-string trap does not apply here). At min 10 and 10%, a THB
29 deposit clears the minimum and truncates to 2, so it reached `TryRecordMission` and
came back not-inserted — genuinely already paid.

### New finding: `already_claimed` is returned for deposits that were never claimed

Found while checking the above. Three different outcomes fall through to the same
`already_claimed` at `mission_service.go:641`:

1. the deposit really was reserved before (`!inserted`) — correct;
2. `deposit.Amount < minTopup` — **never claimed**, mislabelled;
3. `bonus <= 0` after truncation — **never claimed**, mislabelled.

No money is at risk: nothing pays in any of the three. But the endpoint tells a player
their bonus was already collected when it never existed, and it sabotages exactly this
kind of acceptance test — a below-minimum deposit is indistinguishable from a paid one
in the response. Introduced by this task, small, and worth fixing with a distinct status
(`skipped` with a reason) before the run closes.

### To finish the correctness half

The payments were Stripe **sandbox** (`livemode=false`, test card, no money moves), so
another THB 29 top-up costs nothing. Make one, then claim with no `user_id` and require
`credited` with **2**, followed by `already_claimed` on a replay under a different key.

---

## 9. Closed 2026-09-01

Final acceptance passed on live staging. A fresh Stripe sandbox THB 29 deposit reached
`paid` / `fulfilled`; the claim sent **without** `user_id` returned `credited` with
`credited_coins: 2` — 29 at 10% truncated once, matching the integral-credit contract
from #117 — and a replay under a new idempotency key returned `already_claimed`.

Both properties are now proven against real services and a real database rather than
sqlmock, which never reaches a driver:

- **the amount is the server's** — a body carrying `topup_amount: 999999` credits nothing;
- **one deposit pays once** — the reservation is keyed on the `payment_transaction_id`,
  so a fresh caller-chosen idempotency key buys nothing.

Read unambiguously only because #118 had already separated a genuine `already_claimed`
from a below-minimum or zero-bonus skip. Without it, this run would have been repeated.

**Shipped:** Wallet #39 (`49f80c4`) → Missions #116 (`aaf052a`) → #117 (`a65900d`) →
#118 (`81f1146`), all deployed green, Wallet first throughout.

**Split out, not folded in:** TASK-EAR-306 (deposit currency unchecked — a USD deposit
pays the same bonus as the same number of THB) and TASK-EAR-307
(`SumLifetimeTopupMinor` declared but unimplemented, with a live caller in
`Games-Labs-User` getting `Unimplemented` today).

**Production is not patched.** Everything here shipped to staging only.

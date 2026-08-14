# TASK-EAR-257 — Cross-service money-path authorization audit

**Lane:** reviewer (audit-only — nothing was changed, no task was opened)
**Run date:** 2026-08-14
**Code state audited:** `origin/staging` of Games-Labs-Wallet (`a6a994d`, Wallet#20
merged), Games-Labs-Order (`099184f`), Games-Labs-Missions (`e69925e`),
Games-Labs-Game (`91a4d19`), Games-Labs-Provider (`c68db38`), api-gateway
(`83956fb`), shared-lib (`e5fd30e`).

Live probes were run against the deployed staging edges
`https://api-test-gateway.gameslabs.app` (gateway) and
`https://api-dev.gameslabs.app` (Provider ECS staging). **No probe moved money** —
see "Execution evidence" for exactly what was and was not executed.

---

## 0. How reachability was determined

Three independent signals, all used:

1. **Generated bindings** — `runtime.MustPattern` tables in shared-lib
   `proto/**/**.pb.gw.go` give the exact HTTP path each RPC is bound to.
2. **Gateway wiring** — `api-gateway/gateway/grpc.go:86-113` registers which
   pb.gw handlers are mounted; `api-gateway/gateway/http.go` shows the gin
   routes, and `api-gateway/gateway/http.go:122` (`api.Any("/v1/*filepath")`)
   is the only path into the grpc-gateway mux. Service-local `http.ServeMux`
   routes are therefore **not** gateway-reachable unless explicitly proxied
   (`http.go:53-54`, `118-119`).
3. **Live swagger + status probes** — the gateway serves
   `/{svc}/swagger/doc.json` unauthenticated, which lists the routes actually
   deployed today; and 404-vs-401-vs-400 on the edge distinguishes
   "not routed" from "routed behind auth".

Authorization notes that hold everywhere below:

- `middleware.RequireAdminAPIAccess` (`api-gateway/middleware/auth.go:184-193`)
  short-circuits with `c.Next()` for any path not under `/api/v1/admin` or
  `/admin`. Its presence on the `/api` group (`gateway/http.go:113`) proves
  **nothing** about `/api/v1/wallet/*`, `/api/v1/missions/*`, `/api/v1/orders/*`.
- The only trustworthy identity chain is
  `Auth` → `InjectTrustedIdentityHeaders` (`middleware/identity_headers.go:12-22`
  deletes client-sent `userid`/`X-User-ID`/`role`/`permissions`/`access`, then
  re-sets them from validated token context) → `MapMetadataInterceptor`
  → handler reads gRPC metadata.
- `/api/v1/website/` is in the gateway's `SkipPaths` (`gateway/http.go:110`) —
  fully unauthenticated. Audited: `weborderpb` and `webuserpb` expose only
  read-only catalog listings plus `DeleteUser`; **no money path** is on that
  prefix.

---

## 1. Money-path inventory

Legend — Verdict: **OK** = no client-controlled field influences the payout;
**FINDING-n** = see section 2.

### 1.1 Games-Labs-Wallet — `walletpb` (gRPC, gateway-mounted at `gateway/grpc.go:91`)

All routes below confirmed live in `GET /wallet/swagger/doc.json` on staging.

| Path | Transport | Gateway-reachable | Identity source | Authorization | Client fields influencing payout | Verdict |
|---|---|---|---|---|---|---|
| `POST /api/v1/wallet/add-diamond` | gRPC | **yes** (`walletpb/*.gw.go:821`) | **request body `user_id`** (`wallethdl/grpc.go:87`) | **none** | `user_id`, `total_diamond` | **FINDING-2** |
| `POST /api/v1/wallet/credit-diamond` | gRPC | **yes** (`:824`) | **body `user_id`** (`grpc.go:182`) | **none** | `user_id`, `amount`, `reason` | **FINDING-2** |
| `POST /api/v1/wallet/credit-points` | gRPC | **yes** (`:829`) | **body `user_id`** (`grpc.go:293`) | **none** | `user_id`, `points` | **FINDING-2** |
| `POST /api/v1/wallet/reward-package` | gRPC | **yes** (`:826`) | **body `user_id`** (`grpc.go:236`) | **none** | `user_id`, `diamond_amount`, `coin_amount` | **FINDING-2** |
| `POST /api/v1/wallet/exchange-diamonds-to-coins` | gRPC | **yes** (`:825`) | **body `user_id`** (`grpc.go:206`) | **none** | `user_id`, `diamond_amount`, **and `coin_amount`** — the exchange rate is entirely caller-chosen (`walletsvc/service.go:233-250` validates only `>0`) | **FINDING-2** |
| `POST /api/v1/wallet/debit-diamond` | gRPC | **yes** (`:823`) | **body `user_id`** (`grpc.go:155`) | **none** | `user_id`, `amount` | **FINDING-2** (cross-user debit / griefing) |
| `POST /api/v1/wallet/redeem-points` | gRPC | **yes** (`:827`) | **body `user_id`** (`grpc.go:266`) | **none** | `user_id`, `points` | **FINDING-2** |
| `POST /api/v1/wallet/refund-points` | gRPC | **yes** (`:828`) | body `user_id` | **none** | `user_id`, `points` | **FINDING-2** |
| `POST /api/v1/wallet/transfer-coin` | gRPC | yes (`:822`) | **gRPC metadata `access` token** (`grpc.go:120-125`), sender resolved server-side | owner-implicit | recipient, amount (debited from sender) | **OK** — the one correctly-scoped RPC in this service |
| `GET /api/v1/wallet/{userId}` | gRPC | yes (`:820`) | body/path `user_id` | none | — (read) | warning — balance IDOR, not a payout |

### 1.2 Games-Labs-Wallet — `paymentpb` (gRPC, mounted at `gateway/grpc.go:92`)

| Path | Transport | Gateway-reachable | Identity source | Authorization | Client fields influencing payout | Verdict |
|---|---|---|---|---|---|---|
| `POST /api/v1/transaction` | gRPC + mux twin | **yes** (`paymentpb/*.gw.go:152`; probed → 401, i.e. routed behind auth) | **metadata only** (`paymenthdl/grpc.go:53-55,128-131`) ✅ EAR-254 | authenticated caller; `is_demo` staff-gated (`resolveIsDemo`, `grpc.go:106-121` + `demo_gate.go`) | `provider`, `type`, **`status`**, `order_package_id`/`ref_id`, `amount`, `idempotency_id` | **FINDING-1** (`status:"success"` store-purchase fulfilment) |
| ↳ Stripe deposit branch | as above | yes | metadata | `applyStripePackagePriceAuthority` (`paymentsvc/service.go:159`) | `status` **forcibly overwritten to pending** (`service.go:119`); price server-derived | **OK** ✅ EAR-260 |
| ↳ OneDay / UBIT deposit branch | as above | yes | metadata | — | `status` honoured if non-empty (`service.go:97-112`) but only sets `pending` when blank; settlement requires the signed callback | warning (FINDING-1 sibling) |
| `POST /payments/stripe-webhook` | HTTP mux | **yes** — proxied unauthenticated (`gateway/http.go:54`) | n/a (PSP) | **`Stripe-Signature` verified** (`paymenthdl/http.go:263-266`) | none post-verification | **OK** |
| `POST /payments/ubit-deposit-callback` | HTTP mux | **yes** — proxied unauthenticated (`gateway/http.go:53`) | n/a (PSP) | **sign verified** (`ubit_callback.go:25-27`); probed → `400 false` | none post-verification | **OK** |
| `POST /payments/deposit-callback` (OneDay) | HTTP mux | **no** — probed → **404** at the gateway | caller-supplied `uuid`/`refId` | **no signature check at all** (`paymentsvc/callback.go:14-44`) | `confirmStatus`, `amount`, `amountNet` → settles deposit + fulfils package rewards | **FINDING-5** (cluster-internal today) |
| `POST /api/charge/{merchantCode}` | HTTP mux | **yes** — proxied under auth (`gateway/http.go:118`) | none used | authenticated caller only | entire body forwarded verbatim to UBIT under our merchant credentials (`ubit_proxy.go:21-48`) | warning (FINDING-7) |
| `POST /api/queryOrder/{merchantCode}` | HTTP mux | yes (`http.go:119`) | none | authenticated | body forwarded | warning (FINDING-7) |

### 1.3 Games-Labs-Wallet — service-local HTTP mux (`cmd/main.go:112-137`)

`/wallets/credit`, `/wallets/debit`, `/wallets/redeem`, `/wallets/refund-points`,
`/wallets/reward-package`, `/wallets/transfer-coin`, `/wallets/add-diamond`,
`/wallets/exchange-diamonds-to-coins`, `/wallets/convert`,
`/admin/wallets/rate-catalog/upsert`, `/admin/wallets/rate-catalog/deactivate`.

| Column | Value |
|---|---|
| Transport | HTTP mux only |
| Gateway-reachable | **no** — gateway proxies only the four wallet paths listed in 1.2; `/api/v1/*` goes to the grpc mux |
| Identity | trusted headers preferred, body `user_id` as fallback (`paymenthdl/http.go:126-133`) |
| Authorization | none; `role` header is whatever the caller sends |
| Verdict | **FINDING-6** — security rests entirely on network isolation (as task.md predicted). Unchanged risk profile, but it is now the *back* door while §1.1 is an open *front* door |

### 1.4 Games-Labs-Order — `orderpb` (mounted at `gateway/grpc.go:90`)

| Path | Transport | Gateway-reachable | Identity source | Authorization | Client fields | Verdict |
|---|---|---|---|---|---|---|
| `POST /api/v1/orders` (CreateOrder) | gRPC | yes (`orderpb/*.gw.go:1107`) | metadata `callerUUID` (`orderhdl/grpc.go:35`) | caller-scoped; body `user_id` **ignored** | amount/currency validated in service | **OK** ✅ EAR-182 |
| `POST /api/v1/orders/validate-coupon` | gRPC | yes (`:1108`) | metadata (`grpc.go:73`) | caller-scoped | — | **OK** ✅ EAR-182 |
| `GET /api/v1/orders/{id}` | gRPC | yes (`:1109`) | metadata (`grpc.go:118`) | **owner check against fetched row** | — | **OK** ✅ EAR-182 |
| `PUT /api/v1/orders/{id}/status` | gRPC | yes (`:1111`) | metadata | **`auth.RequireStaffGRPC(PERM_ORDER_MANAGEMENT)`** (`grpc.go:239`) | status | **OK** ✅ EAR-182 |
| `POST /api/v1/orders/{id}/confirm-payment` | gRPC | yes (`:1112`) | metadata (`grpc.go:292`) | **owner check on stored row before fulfilment** (`grpc.go:300-312`) | payment_reference | **OK** ✅ EAR-185 |
| `POST /webhooks/payment-callback` | gRPC | **no** — pattern is `webhooks/payment-callback`, outside the `/api/v1/*` catch-all; no gin route exists | **none** | **none** — straight to `ConfirmPayment` → wallet credit (`grpc.go:331-352`) | `order_id`, `payment_reference` | **FINDING-4** (cluster-internal) |
| `POST /api/v1/redemptions/{id}/redeem` | gRPC | yes (`:1117`) | metadata `callerUserID` | caller-scoped | — | **OK** |
| Order service mux: `/api/v1/orders/from-package`, `/exchange`, `/reward`, `ConfirmPaymentHTTP`, `PaymentCallbackHTTP` (`cmd/main.go:109-113`) | HTTP mux | **no** | `X-User-ID` header | internal trust | — | internal-only, same profile as FINDING-6 |

### 1.5 Games-Labs-Missions — `missionspb` (mounted at `gateway/grpc.go:94`)

The gRPC server is a **bridge**: it re-dispatches into the service's own HTTP
handlers (`internal/handlers/mission/grpc/server.go:34-42`) and *does* forward the
trusted identity as `X-User-ID` (`internal/httpx/bridge.go:44-64`,
`internal/httpx/call.go:12-13`). The finding is that most money handlers never
read that header. All paths below confirmed live in
`GET /missions/swagger/doc.json` on staging.

| Path | Gateway-reachable | Identity source | Authorization | Client fields influencing payout | Verdict |
|---|---|---|---|---|---|
| `POST /api/v1/missions/topup-bonus` | **yes** (`missionspb/*.gw.go:3615`) | **body `user_id`** (`mission.go:372`) | **none** | `user_id`, **`topup_amount`**, `idempotency_key` | **FINDING-3 (worst)** |
| `POST /api/v1/missions/boost/claim` | **yes** (`:3614`) | **body `user_id`** (`mission.go:317`) | none | `user_id`, **`turnover`** | **FINDING-3** |
| `POST /api/v1/missions/claim-daily` | **yes** (`:3606`) | **body `user_id`** (`mission.go:50`) | none | `user_id`, `mission_id`, `idempotency_key` | **FINDING-3** |
| `POST /api/v1/missions/claim-daily-group` | **yes** (`:3607`) | **body `user_id`** (`mission.go:109`) | none | `user_id`, `group_id` | **FINDING-3** |
| `POST /api/v1/missions/claim-daily-completion-bonus` | **yes** (`:3622`) | **body `user_id`** (`mission.go:82`) | none | `user_id` | **FINDING-3** |
| `POST /api/v1/missions/check-in` | **yes** (`:3608`) | **body `user_id`** (`mission.go:141`) | none | `user_id` | **FINDING-3** |
| `POST /api/v1/missions/watch-ad` | **yes** (`:3612`) | **body `user_id`** (`mission.go:283`) | none | `user_id`, `ad_id` | **FINDING-3** |
| `POST /api/v1/missions/monthly/claim` | **yes** (`:3621`) | **body `user_id`** (`mission.go:407`) | none | `user_id` | **FINDING-3** |
| `POST /api/v1/missions/streak/check-in` | **yes** (`:3617`) | **body `user_id`** (`mission.go:448`) | none | `user_id` | **FINDING-3** |
| `POST /api/v1/missions/streak/restore` | **yes** (`:3620`) | **body `user_id`** (`mission.go:475`) | none | `user_id` | **FINDING-3** |
| `POST /api/v1/missions/tournament/join` | **yes** (`:3624`) | **body `user_id`** (`mission.go:526`) | none | `user_id` | **FINDING-3** |
| `POST /api/v1/missions/first-register` | **yes** (`:3605`) | **body `user_id`** (`mission.go:252`) | none | `user_id` | **FINDING-3** |
| `POST /api/v1/store/purchase` | **yes** (`:3635`) | **body `user_id`** (`store.go:108`) | none | `user_id`, `package_id`, `coupon_code` | **FINDING-3** |
| `POST /api/v1/store/exchange` | **yes** (`:3636`) | **body `user_id`** (`store.go:243`) | none | `user_id`, `rate_id` | **FINDING-3** |
| `POST /api/v1/store/exchange/custom` | **yes** (`:3637`) | **body `user_id`** (`store.go:278`) | none | `user_id`, `diamonds` | **FINDING-3** |
| `POST /api/v1/store/buy-pass` | **yes** (`:3641`) | **body `user_id`** (`store.go:144`) | none | `user_id`, `pass_id` | **FINDING-3** |
| `POST /api/v1/store/buy-avatar` | yes (`:3642`) | **`X-User-ID` header, body must match or 403** (`store.go:183-204`) | owner-enforced; `price_diamonds` explicitly ignored, Order price authoritative | — | **OK — this is the reference pattern** |
| `POST /api/v1/missions/events/{id}/claim` | yes (`:3598`) | header-first, body fallback (`event.go:103-115`) | weak-but-safe behind gateway | `user_id` only if header absent | warning (FINDING-3 tail) |
| `POST /api/v1/missions/weekly/{id}/claim` | yes (`:3600`) | header-first (`weekly.go:83`) | as above | — | warning |
| `POST /api/v1/levels/redeem` | yes (`:3630`) | `X-User-ID` required (`level.go:99-102`) | owner-enforced | — | **OK** |
| `POST /api/v1/webhooks/store-payment` | **route still registered** (`:3644`) | — | RPC deliberately unimplemented (`grpc/server.go:352-357`); mux route removed and guarded by `routes/apiv1_test.go:24` | — | **OK ✅ EAR-191 verified closed**; residual: see FINDING-8 |

### 1.6 Games-Labs-Provider

Provider's HTTP server has **no auth middleware at all** — `cmd/main.go:327`
wraps `mainHandler` in CORS only — and it is published on the public internet at
`api-dev.gameslabs.app`. Every route is anonymously reachable; the only control
is each handler's own provider-signature check.

| Path | Gateway-reachable | Authentication | Client fields influencing payout | Verdict |
|---|---|---|---|---|
| `POST /afb/round/payout`, `/afb/user/payout` | n/a — **public Provider host** | **fail-open**: `if secretKey != "" && sigKey != "" && signature != ""` (`providerhdl/provider.go:766`) — omit the `Signature` header and no check runs | `username`, `transactions_list[].amount`, `tx_id` → `/wallets/credit` (`services/afb/service.go:451-470`) | **FINDING-0 (critical, executed)** |
| `POST /afb/adjustment` | same | same fail-open (`provider.go:857`) | same | **FINDING-0** |
| `/1up/auth/bets/result`, `/bets/refund`, `/player/balance/get` | public | **HMAC verified**, fail-closed (`providerhdl/oneup_callback.go:34,68,103,149`) | — | **OK** |
| `/supplier/v2/transaction/{bet,win}`, `/wager/cancel`, `/bonus/win` (IDG) | public | `IDGAuthMiddleware` API key, **fails closed in staging/prod when unset** (`idghdl/idg_callback.go:23-47`) | — | **OK** |
| `/vp/transaction` + VP callback route | public | agent-id + AES `cipherText` decrypt, fail-closed (`vphdl/vp_seamless.go:44-57`) | — | **OK** |
| `/sigma/{debit,credit,debit-n-credit,cancel,arcade-settle}` | public | `verifySignature` **fails closed on missing header or unset config** (`sigmahdl/sigma.go:35-45`) | — | **OK** |
| `/ggsoft/seamless/{getBalance,verifyUserBalance}` | public | bearer + signing key, fail-closed (`ggsofthdl/seamless.go:54-70,112-115`) | — | **OK** |
| `providerpb` CRUD `/api/v1/provider*` | yes (`providerpb/*.gw.go:785-789`) | gateway auth only — **not** under `/api/v1/admin`, so `RequireAdminAPIAccess` is a no-op | provider/endpoint config | warning (FINDING-9) |

### 1.7 Games-Labs-Game

No money path. `gamepb` exposes only game listing/launch/category/banner
(`gamepb/*.gw.go:775-784`); the service mux registers only `/health`
(`cmd/main.go:42`); no `/wallets/*` call sites exist in the repo. **Out of scope
after verification, not by assumption.**

---

## 2. Findings, ranked by who can exploit them TODAY

### Tier A — an anonymous caller, no account needed

**FINDING-0 · CRITICAL · AFB payout/adjustment signature check is fail-open**
`Games-Labs-Provider/internal/handlers/providerhdl/provider.go:766` (payout) and
`:857` (adjustment):

```go
if secretKey != "" && sigKey != "" && signature != "" {
    valid := utils.CheckSignatureAFB(...)
    if !valid { respondError(w, "ER4010", ..., 401, traceID); return }
}
```

The guard includes `signature != ""`, so a request that simply **omits** the
`Signature` header skips verification entirely and falls through to
`h.svc.Payout`, which issues `POST /wallets/credit` to the Wallet service with
`UserID = req.Username` and `Amount` taken from `transactions_list[].amount`
(`internal/core/services/afb/service.go:451-470`). Provider's HTTP server has no
auth middleware (`cmd/main.go:327`) and is published at `api-dev.gameslabs.app`.

*Impact:* arbitrary, unauthenticated credit of any player's Coin balance from the
public internet. This is shapes (a), (b) and (d) simultaneously.

*Confirmed by execution* — see section 3.

*Recommendation:* invert to fail-closed (`if signature == "" → 401`), and require
`secretKey`/`sigKey` to be configured in staging/prod exactly as
`idghdl/idg_callback.go:31-34` already does. Also verify whether the same
pattern exists on any other AFB handler in that file.

### Tier B — any ordinary authenticated player

**FINDING-2 · CRITICAL · Wallet's whole `walletpb` surface is an unauthenticated-
identity minting API**
`Games-Labs-Wallet/internal/core/handlers/wallethdl/grpc.go:86` (`AddDiamond`),
`:181` (`CreditDiamond`), `:292` (`CreditPoints`), `:235` (`RewardPackage`),
`:205` (`ExchangeDiamondsToCoins`), `:154` (`DebitDiamond`), `:265`
(`RedeemPoints`). Every one takes `user_id` from `req.GetUserId()` and no
handler consults gRPC metadata; the service layer adds no check either
(`walletsvc/service.go:121-320` validates only non-empty/positive).

These are mounted on the gateway at `gateway/grpc.go:91` and bound to
`/api/v1/wallet/*` (`walletpb/*.gw.go:820-829`) — **outside** `/api/v1/admin`, so
`RequireAdminAPIAccess` never fires. All nine paths are live in the staging
gateway's published swagger (section 3).

*Impact:* any player with a valid token can mint Coin/Diamond/Point into any
account, at any amount. `ExchangeDiamondsToCoins` is worse than an IDOR: **both**
sides of the exchange are caller-supplied, so 1 diamond can be exchanged for an
arbitrary number of coins.

*Note the asymmetry that makes this credible:* `TransferCoin` in the same file
(`grpc.go:119-125`) *does* resolve the sender from metadata. The correct pattern
already exists one function away.

*Recommendation:* resolve the subject from metadata for player-facing RPCs
(`AddDiamond`/`ExchangeDiamondsToCoins`/`RedeemPoints`/`RefundPoints` are the
caller's own wallet); for genuinely administrative ones (`CreditDiamond`,
`CreditPoints`, `RewardPackage`) either move them under `/api/v1/admin/*` or add
`auth.RequireStaffGRPC`, mirroring `orderhdl/grpc.go:239`.

**FINDING-3 · CRITICAL · Missions ignores the trusted identity the bridge already
hands it — 16 gateway-reachable money paths**
Worst instance first:

`Games-Labs-Missions/internal/handlers/mission/http/mission.go:366-396`
(`TopupBonus`) reads `user_id` **and `topup_amount`** from the request body and
passes them to `MissionService.ClaimTopupBonus`
(`internal/services/mission_service.go:528-560`), which computes
`bonus := topupAmount * (bonusPercent / 100.0)` and credits it as **Diamond**
via `s.wallet.Credit` — with **no check that any top-up ever occurred**, no
server-side amount, and no cap. `idempotency_key` is caller-chosen
(`mission.go:381-384`), so the claim is repeatable at will.

`ClaimMissionBoost` (`mission.go:311-341`) has the same shape with a
client-supplied `turnover`.

The remaining 14 (`ClaimDaily` `mission.go:50`, `ClaimDailyGroup` `:109`,
`ClaimDailyCompletionBonus` `:82`, `CheckIn` `:141`, `ClaimCheckInMilestone`
`:180`, `ClaimCheckInDay` `:215`, `FirstRegister` `:252`, `WatchAd` `:283`,
`ClaimMonthlyReward` `:407`, `CheckInStreak` `:448`, `RestoreStreak` `:475`,
`JoinTournament` `:526`, `Purchase` `store.go:108`, `BuyPass` `store.go:144`,
`Exchange` `store.go:243`, `ExchangeCustom` `store.go:278`) take `user_id` from
the body with no header comparison — cross-user reward theft and cross-user
spend.

What makes this cheap to fix and hard to excuse: `httpx.HeadersFromGRPC`
(`internal/httpx/bridge.go:44-64`) **already sets `X-User-ID` from trusted gRPC
metadata** on every bridged call, and `store.go:183-204` (`BuyAvatar`) already
implements the correct header-first + mismatch-403 pattern.

*Recommendation:* apply the `BuyAvatar` pattern to every handler above. Treat
`TopupBonus` and `ClaimMissionBoost` as their own task — they need a server-side
source for the amount, not just an identity fix.

**FINDING-1 · HIGH · Wallet `fulfillGameLabsStorePurchase` pays out on a
client-supplied `status == "success"` — the recorded lead, CONFIRMED**
`Games-Labs-Wallet/internal/core/services/paymentsvc/service.go:238-281`. Trigger
condition is three caller-controlled body fields and nothing else:

```go
if provider != "gamelabs_store"  { return nil }   // :242
if in.Type != "purchase"         { return nil }   // :245
if in.Status != "success"        { return nil }   // :248
```

It then calls `fulfillOrderPackageRewards`
(`paymentsvc/package_fulfillment.go:14-72`), which **does** pay out:
`s.wr.ApplyTransaction(... models.TxCredit ...)` for `pkg.Coin` (`:44-52`) and
`pkg.Diamonds` (`:57-65`). No payment record, no PSP callback, no price check.
Reached via `POST /api/v1/transaction` — bound at `paymentpb/*.gw.go:152`,
mounted at `gateway/grpc.go:92`, probed live → **401** (routed, behind auth only).
The order adapter it depends on is wired in production
(`cmd/main.go:63,109`; `ORDER_API_URL` is set in
`.github/workflows/staging.yml:111` and `ecs/env.names:18`), so the path is live,
not dormant.

*Ranking vs. FINDING-2:* HIGH rather than CRITICAL only because the payout is
bounded by the package catalog (`pkg.Active` is checked at `:267`) and lands in
the caller's own wallet — identity here is correctly taken from metadata
(`paymenthdl/grpc.go:128`, EAR-254's fix holding). Repeatable without limit
because `idempotency_id` is caller-chosen (`service.go:94-96`).

*This is the fifth instance of the class,* and it confirms the second recorded
lead too: `status` is overwritten server-side **only** on the Stripe branch
(`service.go:113-123`, EAR-260's comment says so explicitly); the
`gamelabs_store` branch consumes it raw two lines later at `:125`.

*Recommendation:* `gamelabs_store` fulfilment must be driven by a settled
payment row, not by a request field — the same decision EAR-191 made for the
Missions webhook.

### Tier C — staff only

None found. Every `/api/v1/admin/*` binding checked (`adminwalletpb/*.gw.go:972-983`,
plus `adminorderpb`/`adminmissionpb` — no non-`/api/v1/admin` patterns exist in
either) correctly sits under the prefix that `RequireAdminAPIAccess` gates.

### Tier D — only from inside the cluster

**FINDING-4 · HIGH (internal) · Order `PaymentCallback` asserts payment with no
signature and no caller check** — `Games-Labs-Order/internal/core/handlers/orderhdl/grpc.go:331-352`
goes straight to `ConfirmPayment` (which credits the wallet) on an `order_id`
alone. Not gateway-routed: its pattern is `webhooks/payment-callback`
(`orderpb/*.gw.go:1113`), outside the `/api/v1/*` catch-all, and no gin route
exists. Exactly the EAR-191 shape, surviving in a sibling service. Its
neighbours (`ConfirmPayment`, `UpdateOrderStatus`) were both hardened; this one
was not.

**FINDING-5 · HIGH (internal) · Wallet OneDay `deposit-callback` has no signature
verification** — `paymentsvc/callback.go:14-44` accepts `confirmStatus`,
`amount` and `amountNet` from the payload and settles the deposit plus package
rewards. Contrast its two siblings, which both verify
(`ubit_callback.go:25-27`, `http.go:263-266`). Probed: **404 at the gateway**, so
not externally reachable today — but if OneDay is ever re-enabled it needs a
public route, and that route would arrive unauthenticated. See §4 for the open
question.

**FINDING-6 · MEDIUM (internal) · Wallet's HTTP mux money routes have no
authorization at all** — `cmd/main.go:117-137` exposes `/wallets/credit`,
`/debit`, `/redeem`, `/refund-points`, `/reward-package`, `/transfer-coin`,
`/add-diamond`, `/exchange-diamonds-to-coins` and two `/admin/wallets/rate-catalog/*`
routes on a bare `http.ServeMux`. Not gateway-routed; security is network
isolation, as task.md anticipated. Confirmed still true, and worth its own
decision — but note it is now the *lesser* problem, since FINDING-2 exposes the
same capabilities through the front door.

### Tier E — warnings and residue

- **FINDING-7 · WARNING** — `POST /api/charge/{merchantCode}` and
  `/api/queryOrder/{merchantCode}` (`api-gateway/gateway/http.go:118-119` →
  `paymenthdl/ubit_proxy.go:21-48`) forward an arbitrary caller-supplied body to
  UBIT under our merchant credentials, with no schema validation and no
  identity binding. Any authenticated player can drive our merchant account.
- **FINDING-8 · SUGGESTION** — the `store-payment` webhook route still exists in
  shared-lib (`missionspb/*.gw.go:3644`) and is still mounted by the gateway, so
  `POST /api/v1/webhooks/store-payment` remains publicly advertised even though
  it answers `Unimplemented`. `grpc/server.go:352-357` documents this as
  intentional pending proto removal. Fine as a state, worth closing.
- **FINDING-9 · WARNING** — `providerpb` CRUD (`CreateProvider`/`UpdateProvider`/
  `DeleteProvider`, `providerpb/*.gw.go:785-789`) is bound to `/api/v1/provider`,
  not `/api/v1/admin/...`, so `RequireAdminAPIAccess` does not apply. Not itself
  a payout, but provider endpoint config sits upstream of every settlement path.
  I did **not** verify whether the handlers apply their own staff check.
- **OBSERVATION (not money)** — `webuserpb.DeleteUser` is bound to
  `/api/v1/website/delete-user` (`webuserpb/*.gw.go:152`), which is inside the
  gateway's unauthenticated `SkipPaths` (`gateway/http.go:110`). Outside this
  run's scope; flagged because it was found while establishing that no money
  path lives on that prefix.

---

## 3. Execution evidence

What was executed, verbatim, against staging:

1. `GET https://api-test-gateway.gameslabs.app/health` → `200`.
2. `POST /api/v1/transaction` unauthenticated → `401` (route exists, auth-gated).
3. `POST /payments/deposit-callback` → **`404`** — proves FINDING-5 is not
   externally reachable through the gateway.
4. `POST /payments/ubit-deposit-callback` `{}` → `400 false` — signature path
   reached and rejected.
5. `GET /wallet/swagger/doc.json` → lists `/api/v1/wallet/add-diamond`,
   `credit-diamond`, `credit-points`, `debit-diamond`,
   `exchange-diamonds-to-coins`, `redeem-points`, `refund-points`,
   `reward-package`, `transfer-coin` — **live proof of FINDING-2's reachability
   on the deployed edge**, not just in generated code.
6. `GET /missions/swagger/doc.json` → lists `/api/v1/missions/topup-bonus`,
   `boost/claim`, `claim-daily`, `claim-daily-group`,
   `claim-daily-completion-bonus`, `watch-ad` — same for FINDING-3.
7. **FINDING-0, controlled pair** (the decisive test):
   - `POST https://api-dev.gameslabs.app/afb/round/payout` with headers
     `Signature: bogus, XTime: 1, PlatformURL: x` and body `{}` →
     `{"code":"ER4010","errors":["error signature invalid..."],"status_code":401}`
     — proves `AFB_SECRET_KEY` and `AFB_SIGNATURE_KEY` **are** configured on
     staging and the verifier does run.
   - `POST .../afb/round/payout` with **no `Signature` header** and body `{` →
     `{"code":"ER4000","errors":["Invalid request body: unexpected EOF"],...}`
     — the request reached **body decoding**, i.e. it passed the signature gate.
   - `POST .../afb/adjustment` with no `Signature` header and body `{` →
     the same `ER4000`.

**Deliberately NOT executed:** no request was sent that would credit, debit or
otherwise move a balance. FINDING-0 was proven by reaching the JSON decoder with
a malformed body — bypass demonstrated, no money moved. That is the correct stop
line for an audit, and it means the final step (a well-formed unsigned payout
actually crediting a wallet) is *inferred from source*
(`services/afb/service.go:451-470`), not observed.

---

## 4. What I could NOT determine

1. **Player-token execution of FINDING-1/2/3.** No devtest player credentials
   were available in this session (a recurring gap — see TASK-EAR-128/130/136).
   Reachability is proven from the deployed gateway's own published route list
   and from the generated bindings; **the payout itself is source-traced, not
   observed.** Each of these should get a live cross-user reproduction as the
   RED step of its own fix task.
2. **Whether Wallet's and Order's HTTP ports are reachable from outside the
   VPC.** I established only that the *gateway* does not route them (404 probe).
   Whether an ALB/security-group rule exposes those container ports directly is
   an infra question I could not answer from the repos. FINDING-5 and FINDING-6
   are ranked "internal" on that assumption; if it is wrong, both jump to Tier A.
3. **Whether AFB is an active provider on production.** I confirmed the keys are
   configured on *staging* (probe 7). Production configuration was not checked.
4. **Whether FINDING-9's provider CRUD handlers apply their own staff check.**
   I confirmed the gateway does not gate them; I did not read the handlers.
5. **Prod-vs-staging drift.** Everything here is `origin/staging` source plus
   staging runtime probes. Given the deploy topology, prod may differ; each fix
   task should re-confirm on prod before assuming the same exposure.

## 5. Paths I chose not to examine, and why

- **Games-Labs-User, Games-Labs-Auth, Games-Labs-Logs** — outside the scope
  named in status.yaml. (Auth `staging` also does not currently compile due to a
  stale shared-lib pin; per the run brief that is a dependency-ordering issue,
  not an audit finding, and was ignored.)
- **Backoffice frontend** — no server-side money authority.
- **RabbitMQ consumers** (e.g. Wallet's `UserRegisteredConsumerWithFreeCoin`,
  `cmd/main.go:180`) — they grant free coin on a broker event. Broker access is
  a cluster-internal trust boundary and no external route publishes to it; not
  examined in depth. Worth a follow-up sweep of its own.
- **Provider outbound adapters** (calls we make *to* vendors) — they spend our
  operator balance, not a player's, and are not client-triggered with
  client-supplied amounts on the paths reviewed.
- **Sigma `/arcade-settle`, `/bet-detail`, `/cancel`** — read the shared
  `verifySignature` gate (`sigmahdl/sigma.go:35-45`), which fails closed for the
  whole handler set; individual bodies not read.

---

## 6. Summary counts

| Tier | Count | Findings |
|---|---|---|
| A — anonymous, no account | 1 | FINDING-0 |
| B — any authenticated player | 3 | FINDING-2, FINDING-3, FINDING-1 |
| C — staff only | 0 | — |
| D — cluster-internal only | 3 | FINDING-4, FINDING-5, FINDING-6 |
| E — warning / residue | 3 + 1 obs | FINDING-7, FINDING-8, FINDING-9 |

Money paths examined: **62**. Verified clean: **21** (including all five
correctly-signed provider callback families and the whole of Order's
gateway-facing surface). Out of scope after verification: Games-Labs-Game.

**Recorded-lead verdicts:** lead 1 (`fulfillGameLabsStorePurchase`) —
**confirmed, it does pay out, reachable by any authenticated player** =
FINDING-1. Lead 2 (client-supplied `status` beyond the Stripe path) —
**confirmed**: the `gamelabs_store` branch is the live instance; the OneDay/UBIT
branches accept a caller `status` but require a signed callback to settle; every
*other* status-bearing money row found is written by a verified callback.

No task was opened for any finding, and no file outside this run was written.

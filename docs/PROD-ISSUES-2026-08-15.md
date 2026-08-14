# Production issues — consolidated list

**Compiled:** 2026-08-15 · from TASK-EAR-257 (money-path audit), 265 (infra), 272 (config sweep), and the fix tasks that followed.

**How to read the evidence column.** Everything here was verified against `origin/prod`
branches and live GitHub config. Nothing was probed against a production host — no
production request was sent at any point. Items in section D are the ones the repos
cannot answer and are the reason this list is going to devops.

---

## A. Live on prod and exploitable

### A1 · Provider AFB signature check never runs on prod 🔴
**Anonymous. No account needed.**

`internal/handlers/providerhdl/provider.go` guards signature verification with
`if secretKey != "" && sigKey != "" && signature != ""`. Two independent ways it opens:

- omit the `Signature` header → the block is skipped entirely
- **prod has no AFB secrets at all** → the *first* term is false, so verification never
  runs for any request, signed or not

Four handlers, not two: `GetBalance`, `Payout`, `Adjustment`, `RoundCheck`. `Payout`
reaches `POST /wallets/credit` with a caller-supplied `username` and `amount`.

Provider's HTTP server has **no auth middleware** — CORS only (`cmd/main.go:327`).

| Evidence | |
|---|---|
| Guard present on prod | `git show origin/prod:…/provider.go` → 4 occurrences |
| Prod AFB secrets | `gh secret list --env production` → **none** (staging has all 7) |
| Bypass proven | on staging: bogus signature → 401; **no** signature → past the gate |

**Fix:** Games-Labs-Provider#31 (open). Gate becomes fail-closed, and refuses to serve
(503) when keys are unset in a real environment.

**Devops needs to answer:** is the prod Provider service internet-facing? See D1 — this
is the single question that decides incident vs urgent.

---

### A2 · Wallet `walletpb` takes the subject from the request body 🔴
**Any authenticated player can mint currency into any account, at any amount.**

Every handler in `internal/core/handlers/wallethdl/grpc.go` reads `req.GetUserId()` and
never consults gRPC metadata: `AddDiamond`, `DebitDiamond`, `CreditDiamond`,
`ExchangeDiamondsToCoins`, `RewardPackage`, `RedeemPoints`, `CreditPoints`.

Bound to `/api/v1/wallet/*` — **outside** `/api/v1/admin`, so `RequireAdminAPIAccess`
never fires despite sitting in the middleware chain.

`ExchangeDiamondsToCoins` is the worst: **both sides of the rate are caller-supplied**,
so one diamond buys an arbitrary number of coins.

| Evidence | |
|---|---|
| Present on prod | `git show origin/prod:…/wallethdl/grpc.go` → body identity confirmed |
| Correct pattern exists | `TransferCoin`, same file, 30 lines away, resolves from metadata |

**Fix:** Games-Labs-Wallet#22 — **blocked**, must merge after #21 and ship with
Games-Labs-User#16, or four User flows break (fail-closed, not lossy).

---

### A3 · Missions: 16 money paths take identity from the body 🔴
Cross-user reward theft and cross-user spend across claims, check-ins, streaks,
tournaments and the store. Confirmed present on `origin/prod` (16 occurrences).

**Fix:** Games-Labs-Missions#110 (open).

---

### A4 · Missions `TopupBonus` pays a bonus on a fabricated amount 🔴
`topup_amount` comes from the request body and is multiplied into a Diamond payout, with
nothing establishing that a top-up occurred, and a caller-chosen idempotency key. **An
unbounded faucet, not a one-shot theft.** Confirmed on prod.

**Not fixed.** No trustworthy server-side amount exists yet: Wallet has no read API for
settled deposits (`SumLifetimeTopupMinor` is declared but unimplemented), publishes no
deposit event, and the activity stream Missions consumes has no top-up event type.
Tracked as **TASK-EAR-270** — needs a cross-service contract decision.

Missions#110 does lower the ceiling: the bonus now lands in the caller's own wallet only.

---

### A5 · Wallet fulfils a store package on three client-supplied fields 🟠
`paymentsvc/service.go` — `provider=gamelabs_store`, `type=purchase`, `status=success`
in the body is the entire trigger, then it credits `pkg.Coin` and `pkg.Diamonds`. No
payment record, no PSP callback. Confirmed on prod.

Bounded by the active package catalog and lands in the caller's own wallet (identity here
is correctly from metadata), but repeatable without limit.

**Not fixed.** Tracked as **TASK-EAR-264**.

---

### A6 · Order `PaymentCallback` asserts payment with no signature and no caller check 🟡
Takes an `order_id` alone and goes straight to `ConfirmPayment`, which credits the
wallet. A twin, `PaymentCallbackHTTP`, sat on the internal mux. Confirmed on prod.

Not gateway-routed, so cluster-internal — see D2 before treating that as safe.

**Fix:** removed entirely (no producer has ever existed — `git log -S` shows no commit
ever added a caller). Branch ready, PR not yet opened. **TASK-EAR-267**.

---

### A7 · Wallet Stripe underpayment — ✅ **FIXED ON PROD 2026-08-15**

*Kept in this list because it was live on production and the timeline matters.*

**What it was:** the Stripe checkout amount came from the client request and was never
compared to the package price; the callback then granted the package's full rewards
regardless. **Pay 1 THB, receive the 29 THB package.**

**Why it was on prod at all:** the vulnerable Stripe path reached prod on
**2026-08-14 13:43 +07** via a `staging → prod` merge. The fix merged to staging at
**17:25 +07** — *after* that promotion. Production carried the hole without the fix for
roughly a day.

**Probable mitigation during that window, never confirmed at runtime:** Wallet's
production environment has no Stripe secrets (`gh secret list --env production` → none;
staging has 3), so a checkout session likely could not be created there. Inference from
config, not a runtime check.

**Fixed:** Games-Labs-Wallet#23 promoted staging → prod. Prod tip `d8d460e`, deploy run
**completed success**. Verified on `origin/prod` after the merge — the price authority is
present, and `prod.yml` / `ecs/env.names` kept their production values, including
`ORDER_API_URL`, which the fix depends on to load the package from Order.

**Transferable note for devops:** `git diff prod..staging` renders prod-only commits as
deletions and made this promotion look destructive when it was not. Staging had never
touched `prod.yml` or `ecs/env.names`, so the three-way merge kept prod's versions. The
reliable check is a dry-run merge on a throwaway branch, not a diff.

---

## B. Live on prod and silently disabled or broken

These share one mechanism: `ecs/build-env-json.sh` renders any name listed in
`ecs/env.names` that the workflow did not export as `{"name":X,"value":""}`. **The deploy
succeeds, nothing is logged, and the feature is simply off.**

### B0 · Missions on prod points at the **staging** Cloud Map namespace 🔴 **NEW — live regression, 2026-08-14 06:45 UTC**

Found while fixing B1; the first sweep missed it because it is not a dropped variable —
this one **did reach the running task**.

`Merge branch 'staging' into prod` (`1886232`) pulled staging's copy of `prod.yml`,
which swapped the service-discovery namespace:

| | value |
|---|---|
| `1886232^` (before) | `games-labs-prod.local` ✅ |
| `origin/prod` (now) | `games-labs.local` ← **staging's namespace** |
| Wallet / Order / Provider prod | `games-labs-prod.local` ✅ |

`WALLET_BASE_URL` and `ORDERS_API_URL` **are** listed in `env.prod.names`, so unlike the
B1 variables the wrong value was rendered into the task definition and deployed. On the
repo evidence, **Missions' HTTP calls to Wallet and Orders on production have been
resolving against a namespace that does not exist since 2026-08-14 06:45 UTC** — roughly
29 hours.

**Fixed in the same commit as B1** (branch `fix/TASK-EAR-273-missions-prod-env`, not yet
pushed). ⚠️ **Confirm with devops that prod's namespace really is `games-labs-prod.local`
before deploying** — this was verified from the repo only, no AWS access. See D6.

Also worth pulling CloudWatch `/ecs/games-labs-missions-prod` from that timestamp: the
`player.activity` consumer `Nack`s with `requeue=true` and has no DLQ or backoff, so a
dead dependency becomes an infinite requeue loop.

### B1 · Missions prod renders from the wrong names file 🔴 — ✅ **CONFIG HALF FIXED**
`prod.yml` reads **`ecs/env.prod.names`**, not `env.names`. It `export`s variables that
file never lists, so they never reach the task.

**Correction to the original entry:** `env.prod.names` is not an unreconciled fork. It was
created deliberately on 2026-07-01 (`cfb4e6f`) when prod moved `POSTGRES_USER`/`PASSWORD`
into Secrets Manager, and **at creation it listed exactly what `prod.yml` exported**. The
mismatch is 29 hours old, not of unknown age — the same `1886232` merge as B0 took
staging's export block while keeping prod's `env.prod.names` line.

Adopting `env.names` on prod would **take prod down**, proved by rendering it: zero
`POSTGRES_*` names and `DATABASE_URL=""` → `POSTGRES_HOST` defaults to `localhost` →
`log.Fatalf` on the failed ping → crash-loop and ECS rollback. The fix is the reverse —
add the missing names to `env.prod.names`.

| Dropped | Runtime effect on prod |
|---|---|
| `USE_ORDERS_CATALOG` | `UseOrdersCatalog()` returns **false** → the store runs the **legacy direct-wallet path**, contradicting the Orders-catalog contract |
| `ORDER_SERVICE_ADDR` | → `localhost:50051` |
| `USER_SERVICE_ADDR` | → `localhost:50055` |
| `GAME_SERVICE_ADDR` | → `localhost:50053` |
| `USER_HTTP_URL`, `USE_WALLET_RATE_CATALOG`, `STORE_PROVIDER_TIMEOUT_SECONDS`, `RABBITMQ_QUEUE_PLAYER_ACTIVITY_MISSIONS` | defaults / off |

The workflow *intends* the opposite — `prod.yml:105` literally says
`export USE_ORDERS_CATALOG="true"`. It has simply never taken effect.

**Split deliberately, as the operator asked.**

- **Step 1 — config repair, committed** (`0172e35`): the three service addresses,
  `USER_HTTP_URL`, `STORE_PROVIDER_TIMEOUT_SECONDS`, the RabbitMQ queue name, and the
  B0 namespace. `USE_ORDERS_CATALOG` is **provably absent** from the new names file.
- **Step 2 — the money-path change, NOT committed**: today `USE_ORDERS_CATALOG=false`
  means `StoreService.seed()` serves a **hardcoded Go slice of packages and prices
  compiled into the binary**. Turning it on moves prices to the Orders catalog, so if the
  two disagree, **prices change visibly the moment the task starts.** That needs a price
  diff and a deploy window, not a config PR.

What the dropped addresses actually break: all three clients use `grpc.NewClient` without
`WithBlock`, so nothing fails at boot and nothing is logged — failures appear per-RPC.
Order breaks the store pass / avatar / inventory endpoints loudly, and is **not** gated by
`USE_ORDERS_CATALOG`. User is the worst shape: `GET /levels/{id}` **silently returns 200
with a fabricated Level 1 / 0 EXP** instead of erroring, and leaderboards render blank
names. That fabricated-level path plausibly explains cross-service behaviour that has
looked flaky.

⚠️ **Structural hazard:** `prod.yml` on `main`/`staging` is still drifted, so **every
future `staging` → `prod` merge re-breaks this** — same class as Provider's `prod.yml`.
Needs its own task.

### B2 · Games-Labs-User has no wallet address on prod 🔴
`prod.yml` exports **neither** `WALLET_HTTP_ADDR` nor `WALLET_GRPC_ADDR`
(`staging.yml:104-105` exports both). `NewAdapter` returns a nil adapter when both are
empty → **User's wallet calls are already non-functional on production**: display-name
change, VIP purchase, VIP level rewards.

Pre-existing, not caused by any change in flight. `WALLET_HTTP_ADDR` **must** be exported
before the TASK-EAR-271 chain reaches prod.

### B3 · Games-Labs-User `GAME_API_URL` missing on prod 🟠
Same shape. `game` adapter stays nil → VIP level-detail returns
`ErrGameAdapterNotConfigured` on prod.

### B4 · Provider win capture is off on prod 🟠
`WIN_CAPTURE_PROVIDERS` is in `env.names` but was never exported by `prod.yml`. Win
capture has been **off on production** regardless of what EAR-192/194 shipped.

**Fix:** Games-Labs-Provider#32 (open). ⚠️ **It will still render empty after merging** —
the variable exists only at *staging* environment scope. Someone must create
`WIN_CAPTURE_PROVIDERS` at **production** scope.

---

## C. Security hygiene on prod

### C1 · RDS traffic from Provider is unencrypted 🔴
`config/config.go:211` hard-codes `q.Set("sslmode", "disable")`. `prod.yml` exports
`POSTGRES_SSLMODE`, but that name **is not in Provider's `ecs/env.names`**, so it is
dropped — and the accessor would ignore it anyway.

**Not fixed.** Needs its own task. Worth confirming with devops whether the RDS instance
enforces TLS at the server side, which would make this moot.

### C2 · `AFB_SIGNATURE_KEY` is in the repository in plaintext 🔴
`server.log` is a **tracked file on `main`, `staging` and `prod`** and contains a
`ResponseStringToSign` entry. Per `utils/signature.go:126` that string is
`platformURL + payload + xTime + signatureKey` — so the signature key is readable by
anyone with repo access. `.gitignore` has **no `.log` pattern**.

Partially mitigating: the HMAC `secretKey` is *not* in that string, so it is half the
signing material, not a working forgery.

**Tracked as TASK-EAR-269.** Rotation and any history rewrite are operator decisions —
not started.

---

## D. Questions only devops can answer

These gate the severity of several items above. Each is cheap.

### D1 · Is `provider-alb-prod` internet-facing? 🔴 **highest value**
The infrastructure snapshot **contradicts itself** — internet-facing in two places
(`SparqLab_Infrastructure_Report…:840-844`, `html/gamelabsAws.html:399`, plus a
public-subnet diagram) and **Internal** in a third (`html/Cost-Report.html:167`).

This single answer decides whether **A1** is an incident or an urgent fix.

```bash
aws elbv2 describe-load-balancers --names provider-alb-prod \
  --query 'LoadBalancers[].{scheme:Scheme,subnets:AvailabilityZones[].SubnetId}'
```

### D2 · Are Wallet's and Order's container ports reachable from outside the VPC?
Answered **"no"** in TASK-EAR-265, but from a **7.5-week-old snapshot** with no live AWS
access. The verdict rests on a closed target-group inventory that contains no Wallet or
Order entry.

Two caveats that survive the "no":
- `8080–8087 ← ALB SG` is **already permitted** in both environments, so attaching a
  target group later would expose `/wallets/credit` **with no security-group diff** for a
  reviewer to catch.
- Wallet's mux (`/wallets/credit`, `/debit`, `/redeem`, …) has **no authorization at all**;
  its only control is network isolation.

```bash
aws ecs describe-services --cluster <prod-cluster> \
  --services games-labs-wallet-prod games-labs-order-prod \
  --query 'services[].{name:serviceName,lb:loadBalancers,net:networkConfiguration}'
```

### D3 · Is the legacy Contabo k3s cluster still running?
`Games-Labs-Wallet/k3s/service.yaml:14` still declares **NodePort 30400 → 8084**, and both
Wallet and Order still carry `k3s/argocd-app.yaml` with ArgoCD `automated + selfHeal`.
Last deploy 2026-06-17.

**Dormant is not decommissioned.** If that cluster still runs, a June-vintage Wallet with
the same unauthenticated mux is still serving — a build predating every fix in this list.
This is the weakest link in D2's "no" and the one gap the audit could not close.

### D4 · Do the prod ECS task definitions match the repo?
Everything in section B is derived from the workflows. If any task definition was
hand-edited in the console, the live environment may differ in either direction.

### D5 · Is AFB an active provider on prod?
Keys are absent from the production environment, but org-level GitHub secrets are
unreadable (`gh secret list --org` → HTTP 403). If `AFB_SECRET_KEY` were defined
org-wide it would resolve non-empty, which changes A1's shape.

Argument against (inference, not proof): staging defines them at *environment* level — if
an org-level secret existed, staging would not need its own copy.

### D6 · What is prod's Cloud Map namespace, and what do Missions' logs show since 2026-08-14 06:45 UTC? 🔴 **new**
Gates B0. Three other prod services use `games-labs-prod.local`, so the fix assumes that
is correct — but it has not been checked against live AWS.

```bash
aws servicediscovery list-namespaces --region ap-southeast-1 --query "Namespaces[].Name"
```

Then pull `/ecs/games-labs-missions-prod` from that timestamp and look specifically for
repeated `player.activity` consumer errors — that consumer requeues forever with no DLQ.

---

## Suggested order for the devops conversation

1. **B0** — a live prod regression roughly 29 hours old, with a fix already written.
   One command (**D6**) confirms it.
2. **D1** — one command, decides whether A1 is an incident tonight.
3. **D3** — if that cluster is alive, several "internal-only" verdicts change at once.
4. **B1 / B2** — prod is running configurations nobody intended; these are quiet and have
   been quiet for a while.
5. **C1** — confirm whether RDS enforces TLS server-side before treating it as urgent.
6. **A7 promotion** — the underpayment fix exists and is merged to staging; the only
   reason it is not on prod is timing.

## What is already in flight

| PR | Covers |
|---|---|
| Games-Labs-Provider#31 | A1 |
| Games-Labs-Provider#32 | B4 (plus a prod.yml drift resync) |
| Games-Labs-Missions#110 | A3, and lowers A4's ceiling |
| Games-Labs-Wallet#21 → #22 → Games-Labs-User#16 | A2, in that order |
| Games-Labs-Wallet#20 → #23 | A7 — ✅ **on prod, deploy verified** |
| api-gateway#49 | unrelated (completes the device-API chain) |

Open with no PR yet: **A4** (TASK-EAR-270), **A5** (264), **C2** (269).

Branch ready, not pushed: **B0 + B1 step 1** (TASK-EAR-273,
`fix/TASK-EAR-273-missions-prod-env`, holding on D6), **A6** (267 — now PR
Games-Labs-Order#41), **B3** (User#17), **C1** (Provider#33).

Still unwritten: **B1 step 2** (`USE_ORDERS_CATALOG`), and the `prod.yml` drift that
re-breaks B0/B1 on every `staging` → `prod` merge.

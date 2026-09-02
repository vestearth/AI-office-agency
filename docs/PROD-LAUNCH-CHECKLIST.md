# Production launch checklist — target 2026-09-20..23

Written 2026-09-02. Every claim below was verified against live AWS (`vestearth`,
account `122991883560`) or live GitHub config, not against the repository alone.

---

## Recommendation on how to structure this — you asked, so here it is

**Two gates in one document, and they are not symmetric.** That falls out of one fact:

> **Production has nothing running.** 8 of 9 services on `sparqlab-production-ecs` are at
> `desiredCount: 0`. Nothing can be *tested* there, because there is nothing to test.

So:

- **Gate 1 — prove it on staging.** Every "does this actually work" item lives here,
  because staging (`sparqlab-development-ecs`, all 9 services at 1/1) is the only place
  behaviour can be observed. Anything not proven on staging will be discovered in
  production.
- **Gate 2 — production cutover.** Config, secrets, data isolation, and scale-up order.
  Nothing behavioural — by the time you are here, behaviour is already settled.

Do **not** try to verify Gate 2 items on staging or Gate 1 items on prod. That confusion
is what produced a month of "live on prod" claims about a cluster that was switched off.

---

## 🔴 The thing that actually blocks launch

**Production has no integration credentials at all.** Every production GitHub environment
holds database and Redis secrets only. Verified by listing both environments per repo.

| Service | production env has | **missing on production** |
|---|---|---|
| **Wallet** | `POSTGRES_*`, `RDS_POSTGRES_SECRET_ARN` | **all Stripe** (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`) · **all UBIT** (`UBIT_AES_KEY`, `UBIT_AES_IV`, `UBIT_BASE_URL`, `UBIT_MERCHANT_CODE`, `UBIT_RECHARGE_CALLBACK_URL`) |
| **Provider** | `POSTGRES_*`, `REDIS_*`, `RDS_POSTGRES_SECRET_ARN` | **every game provider** — `AFB_*` (5), `GGSOFT_*` (7), `IDG_*` (5), `ONEUP_*` (5), `VP_*` (5) · plus `ADMIN_API_KEY`, `API_KEYS`, `USER_API_URL`, `WALLET_API_URL` |
| others | `POSTGRES_*` | to be audited the same way — assume gaps |

**Consequence if launched as-is:** no player can pay (no Stripe, no UBIT) and no game can
launch or settle (no provider credentials). This is not a security backlog item — it is
"production has never been configured for real traffic".

`GH_PAT` and the AWS keys **are** present at repo level and inherit, so the prod *build*
works. It is only the integrations that are absent.

**≈40 secrets to provision across services.** That is the long pole for a 20–23 Sept
date, and it needs a named owner today.

---

## 🟠 Two shared-resource problems to decide before cutover

Both are cases where production would quietly share a QA resource.

### RabbitMQ is repo-level, so prod and staging share one broker
`RABBITMQ_URL` is a **repo-level** secret in Wallet and Provider, and neither the
`staging` nor the `production` environment overrides it. Production would publish and
consume on the **same broker as QA** — same queues, same consumers. A staging consumer
could process a production event.

### ClickHouse points at one box for both — tracked as TASK-EAR-308
No `CLICKHOUSE_ADDR` variable exists in the production environment, so `prod.yml:87` falls
back to the literal `84.247.150.206:9000` — the same host staging's variable points at,
and the same default `gameslabs` database. Also: bare public IP, port 9000 is ClickHouse's
**plaintext** native protocol (TLS is 9440), and **no ClickHouse secret exists in either
environment**, so username falls back to `default` and password to empty.

Neither is urgent while prod is off. Both are launch blockers.

---

## Gate 1 — prove on staging

Ordered by what would hurt most if it were wrong in production.

### Money paths — behaviour
- [ ] **Wallet body-identity is dead.** As player A, call a `walletpb` money RPC through
      the gateway with player B's id in the body; the movement must land on **A**. Cover
      `ExchangeDiamondsToCoins` first — it took *both sides of the rate* from the caller.
      *(TASK-EAR-262, merged, never exercised.)*
- [ ] **Missions cross-user claim is refused** — 403 with another player's `user_id`, 401
      with no `X-User-ID`. Through the gateway, not the Missions mux. *(263)*
- [ ] **Order's payment callback is gone** — both the gRPC binding and the mux twin
      `/webhooks/payment-callback` return 404/Unimplemented, and the EAR-185 ownership and
      EAR-182 staff guards still hold. *(267)*
- [ ] **User's four wallet flows still work** — display-name change, VIP purchase, VIP
      level rewards, and the fourth credit path. These fail closed, so a mistake here is
      breakage rather than a leak. *(271)*
- [ ] **Stripe end to end on staging sandbox**, including the underpayment guard and the
      TopupBonus payout bound to `payment_transaction_id`. *(260, 270)*

### Still-open defects that must not reach production
- [ ] **TASK-EAR-264** — Wallet fulfils a store package on three client-supplied body
      fields. Unlimited self-enrichment.
- [ ] **TASK-EAR-275** — any authenticated player can create/update/delete providers **and
      provider endpoints**, including `api_base_url`. Upstream of every settlement path.
- [ ] **TASK-EAR-266** — Wallet's bare `http.ServeMux` exposes eight money endpoints with
      no authorization, plus an unsigned OneDay deposit callback. Ports are not
      VPC-external (D2), so network isolation is the *only* control.
- [ ] **TASK-EAR-269** — rotate `AFB_SIGNATURE_KEY`; it is in the repo in plaintext.
      Rotation is the work, not deleting the line. **Do this before provisioning the
      production AFB secrets, not after.**
- [ ] **TASK-EAR-268 residue** — no rate limiting is wired anywhere at the gateway.
      `middleware/ratelimit.go` is fully implemented and never mounted, which leaves
      `/api/v1/website/delete-user` an unthrottled credential check whose success case
      **deletes the account**.

### Config correctness
- [ ] **Provider talks TLS to RDS** — confirm the running task used `sslmode=require`.
      Boot success is not proof. *(274)*
- [ ] **`WIN_CAPTURE_PROVIDERS` is non-empty in the running staging task**, not merely
      present in `ecs/env.names`. *(272)*
- [ ] **Demo deposits are gated** — a non-staff player gets a real charge, not a free
      package. Needs `ORDER_MANAGEMENT` granted to QA first. *(254)*

---

## Gate 2 — production cutover

### Secrets and configuration
- [ ] Provision every missing integration secret listed above, per service, in the
      **`production` GitHub environment**. Confirm each is a **production** credential,
      not a copy of the staging one.
- [ ] Decide and set the production **RabbitMQ** — a separate broker, or an accepted
      shared one with a documented reason.
- [ ] Decide and set the production **ClickHouse** target, and remove the hardcoded
      fallback from `prod.yml` so an unset address fails the deploy instead of silently
      pointing at staging's box. *(TASK-EAR-308)*
- [ ] Audit the remaining services' `production` environments the same way — Order,
      Missions, User, Auth, Game, Logs, api-gateway.

### Branch promotion — the deploy is the merge
No `on: pull_request` workflow exists in any Games Labs repo, so a promotion PR shows
**zero checks** and merging **is** the deploy. Current backlog:

| Wallet | Logs | gateway | Missions | Provider | Auth | Order | User | Game |
|---|---|---|---|---|---|---|---|---|
| **46** | 24 | 18 | 13 | 12 | 12 | 10 | 10 | 7 |

- [ ] Promote in dependency order, **api-gateway last** — it owns the wire format and has
      been the missed step five times.
- [ ] For each: dry-run merge on a throwaway branch and inspect the merged tree.
      `git diff prod..staging` renders prod-only commits as deletions and has already made
      one safe promotion look destructive.
- [ ] Land **TASK-EAR-273** (Missions#119) before Missions is scaled up — the registered
      task definition `games-labs-missions-prod:16` carries staging's Cloud Map namespace
      and is missing every `*_SERVICE_ADDR`.
- [ ] Open a task for the **`prod.yml` drift**: `main`/`staging` still carry a stale
      `prod.yml`, so **every future `staging` → `prod` merge re-breaks 273's fix.**

### Migrations
- [ ] Missions and Game **replay every migration on boot** with no version table, so every
      statement must be idempotent or the first prod boot crashes. Re-check any migration
      added since the last prod deploy.
- [ ] Confirm prod DB users/passwords resolve from Secrets Manager
      (`RDS_POSTGRES_SECRET_ARN`) rather than plain task env.

### Scale-up
- [ ] Bring services up in dependency order — Auth, User, Wallet, Order, Game, Provider,
      Missions, Logs — and confirm each reaches steady state **with running tasks**, not
      merely "steady state" at zero, which is what the cluster reports today.
- [ ] `api-gateway-prod` already runs 1 task with every backend off. Confirm it picks up
      the backends rather than needing a restart.
- [ ] Both prod ALBs (`gamelabs-alb-prod`, `provider-alb-prod`) are **`internal`**. Confirm
      that is intended for launch, and that whatever fronts them publicly is in place.

### Rollback
- [ ] Rollback is **deploy the previous task-definition revision** — there is no pin-revert
      and no `rollout restart` on this lane. Record the last-known-good revision per
      service *before* cutover.
- [ ] `wait-for-service-stability: true` must stay on; without it a crash-looping task
      reports a green deploy.

### Observability before traffic, not after
- [ ] Confirm each service's CloudWatch log group `/ecs/<service>-prod` exists and the
      `jq` render targets the same name — a mismatch makes logs vanish while the deploy
      stays green.
- [ ] Missions' `player.activity` consumer `Nack`s with `requeue=true` and has **no DLQ and
      no backoff** — a dead dependency becomes an infinite requeue loop. Decide whether
      that ships as-is.

---

## What will not be ready, and does not need to be

**The Admin Monitoring epic** (283–301). 284 is done and 287/288/289/290/293 have landed,
but 285 is still in progress and 286/291/292 are blocked. It is staging-side work and
**not launch-critical** — Monitoring is an internal backoffice surface. Let it finish on
staging after launch. TASK-EAR-308 only needs answering if you want Monitoring on prod.

**Backoffice gaps** — 22 Monitoring pages, 3 Website pages, 19 unbuilt nav routes. None
gate player-facing launch.

---

## Honest read on the date

The security backlog is tractable in 18 days; most items have branches or clear scope.
**The credential provisioning is the risk** — roughly 40 secrets across services, each
needing a real production account with a payment or game provider, and several of those
(Stripe live keys, provider merchant credentials) depend on third parties rather than on
us. Started this week it fits; started in the final week it does not.

The single most useful thing you can do today is name an owner for that list.

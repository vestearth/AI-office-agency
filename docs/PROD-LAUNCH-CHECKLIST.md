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

## 🔴 The thing that actually blocks launch — full audit, all 9 services

**Method** (stricter than a secret-list diff): for each service, extract every
`secrets.X` reference from `origin/prod:.github/workflows/prod.yml`, subtract what exists
at **production-environment** *and* **repo level** (repo secrets inherit), then classify
each gap by what the workflow actually does when it is absent.

`AWS_ACCOUNT_ID` is missing everywhere and is **not** a gap — every workflow falls back to
`aws sts get-caller-identity`. `GH_PAT` and the AWS keys are repo-level, so the prod
**build** works everywhere.

### Verdict per service

| Service | referenced | **must provision** | benign |
|---|---|---|---|
| **Provider** | 49 | **31** | 3 have defaults |
| **Wallet** | 21 | **11** | — |
| Order | 17 | 0 | `S3_FORCE_PATH_STYLE_PROD` is not in `env.names`, inert |
| Auth | 19 | 0 | 2 queue names default |
| Logs | 14 | 0* | 3 default; `CLICKHOUSE_PASSWORD` → *explicit empty* |
| User | 13 | 0 | 1 queue name defaults |
| Missions | 10 | 0 | — |
| Game | 16 | 0 | — |
| api-gateway | 6 | 0 | — |

**42 real credentials, and they sit in only two services.** The other seven are
configured. That is much better news than the first pass suggested — the work is
concentrated, not spread.

### Wallet — 11, all payments

`STRIPE_SECRET_KEY` · `STRIPE_WEBHOOK_SECRET` · `STRIPE_PUBLISHABLE_KEY` ·
`STRIPE_SUCCESS_URL` · `STRIPE_CANCEL_URL` · `STRIPE_RECEIPT_EMAIL` ·
`UBIT_AES_KEY` · `UBIT_AES_IV` · `UBIT_BASE_URL` · `UBIT_MERCHANT_CODE` ·
`UBIT_RECHARGE_CALLBACK_URL`

None has a default; each renders empty and the feature is simply off. **No player can pay.**

### Provider — 31, all game integrations

| provider | count | keys |
|---|---|---|
| GGSOFT | 8 | `BASE_URL`, `CALLBACK_URL`, `KEY`, `SIGNING_KEY`, `USERNAME`, `SEAMLESS_USERNAME`, `SEAMLESS_PASSWORD`, `SEAMLESS_JWT_SECRET` |
| AFB | 6 | `BASE_URL`, `CALLBACK_URL`, `PLATFORM_URL`, `PLATFORM_ALIAS`, `SECRET_KEY`, `SIGNATURE_KEY` |
| IDG | 5 | `API_HOST`, `API_KEY`, `CALLBACK_URL`, `INBOUND_API_KEY`, `INTEGRATOR` |
| ONEUP | 5 | `API_KEY`, `SECRET_KEY`, `OPERATOR`, `PLATFORM_URL`, `CALLBACK_URL` |
| VP | 5 | `AGENT_ID`, `API_KEY`, `SECRET_KEY`, `BASE_URL`, `CALLBACK_URL` |
| own auth | 2 | `ADMIN_API_KEY`, `API_KEYS` |

**No game can launch or settle.** ⚠️ `AFB_SIGNATURE_KEY` is currently in the repo in
plaintext (TASK-EAR-269) — **rotate it before provisioning the production value**, not
after.

### 🔴 RabbitMQ — split brain **confirmed**, and prod shares a broker with staging

Compared by reading the **rendered ECS task definitions** (GitHub secrets are write-only;
the deployed values are not). Values were hashed and hosts redacted of credentials — the
raw strings were never printed.

| task definition | broker | port | fingerprint |
|---|---|---|---|
| **`games-labs-missions-prod`** | **`b-e177fb2b-….mq.ap-southeast-1.on.aws`** — Amazon MQ | **5671** (TLS) | `3a9c5231f85c` |
| `games-labs-wallet-prod` | `84.247.150.206` | 5672 (plaintext) | `07b7ced3df69` |
| `games-labs-order-prod` | `84.247.150.206` | 5672 | `07b7ced3df69` |
| `games-labs-game-prod` | `84.247.150.206` | 5672 | `07b7ced3df69` |
| `games-labs-auth-prod` | `84.247.150.206` | 5672 | `07b7ced3df69` |
| `games-labs-user-prod` | `84.247.150.206` | 5672 | `07b7ced3df69` |
| `games-labs-logs-prod` | `84.247.150.206` | 5672 | `07b7ced3df69` |
| `games-labs-*-staging` (4 checked) | `84.247.150.206` | 5672 | `07b7ced3df69` |

Three separate problems fall out of one table.

**1 · Missions-prod cannot hear its publishers.** It is the only service on Amazon MQ.
Game, Order and Wallet publish `player.activity` to the Contabo broker; Missions-prod
listens on a different broker entirely. **It would receive nothing, and nothing would
error** — no missing config, no failed connection, just silence. Daily/weekly progress,
check-ins and turnover missions would all sit at zero. This looks like a partial migration
to Amazon MQ that only reached one service.

**2 · Production and staging are the same broker, byte-identical.** The fingerprint
`07b7ced3df69` is the same string — same host, same `admin` user, same password, same
vhost `/` — across every staging service *and* six prod services. The queue names also
default identically on both. RabbitMQ round-robins between consumers on a queue, so once
prod scales up, **production events would be randomly delivered to staging consumers and
vice versa.** On money-adjacent streams that is not a QA nuisance.

**3 · The legacy Contabo box is load-bearing for production.** `84.247.150.206` is the
same host the production ClickHouse falls back to (TASK-EAR-308). **This answers D3** in
`PROD-ISSUES-2026-08-15.md`: the legacy estate is not decommissioned — it currently holds
both the message broker and the analytics store that production points at, on a public IP,
on plaintext ports (5672 / 9000).

Also worth noting: `RABBITMQ_URL` carries its credentials in **plain task-definition
environment**, readable by anyone with `ecs:DescribeTaskDefinition` — the same exposure
that `POSTGRES_USER`/`PASSWORD` were deliberately moved out of into Secrets Manager.

- [ ] **Decide the production broker** — Amazon MQ (already provisioned, TLS) or Contabo.
      Then point **every** service at it, not one.
- [ ] **Separate staging from production**, whichever is chosen. Different broker, or at
      minimum different vhost *and* different credentials. Identical queue names on a
      shared broker is the actual hazard.
- [ ] **Move `RABBITMQ_URL` into Secrets Manager** alongside the DB credentials, rather
      than leaving it in plain task env.
- [ ] Re-check after the change that every service's rendered task definition shows the
      **same** fingerprint — that comparison is cheap and would have caught this.

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

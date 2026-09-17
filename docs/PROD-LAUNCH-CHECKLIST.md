# Production launch checklist — target 2026-09-20..23

Written 2026-09-02. **Gate 2 refreshed 2026-09-17, after the TASK-EAR-363 train merged.** Every claim below was
verified against live AWS (`vestearth`, account `122991883560`) or live GitHub config, not
against the repository alone. Sections above Gate 2 keep their 09-02 wording; where Gate 2
says otherwise, Gate 2 is current.

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

> **2026-09-17:** Order's SMTP and every other non-Wallet/Provider gap are closed. Wallet 11
> and Provider 31 are unchanged. Current state: Gate 2 → Secrets and configuration.

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

> **✅ Resolved 2026-09-17** — separate prod broker; all eight prod task definitions render
> one fingerprint, distinct from staging. The 09-02 analysis below is kept as history.
> Current state: Gate 2 → RabbitMQ.

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

> **Refreshed 2026-09-17, after the TASK-EAR-363 train merged.** Verified against
> `origin/prod` vs `origin/staging` (or `origin/main` for backoffice), GitHub secret
> *names*, and the live task definitions and scalable targets on
> `sparqlab-production-ecs`. Superseded items are struck through, not deleted.

### Prod completeness in one table

Source lane = `staging`, or `main` where a repo has no `staging`. "Missing" means
patch-unique non-merge commits on the source lane that `prod` lacks.

| Repo | source | missing | prod revision | image = `prod` HEAD | desired / running |
|---|---|---|---|---|---|
| Auth | staging | **0** | `:25` | ✅ | 0/0 |
| User | staging | **0** | `:17` | ✅ | 0/0 |
| Wallet | staging | **0** | `:18` | ✅ | 0/0 |
| Order | staging | **0** | `:22` | ✅ | 0/0 |
| Game | staging | **0** | `:22` | ✅ | 0/0 |
| Missions | staging | **0** | `:20` | ✅ | 0/0 |
| Provider | staging | **0** | `:18` | ✅ | 0/0 |
| Logs | staging | **0** | `:12` | ✅ | 0/0 |
| api-gateway | staging | **0** | `:17` | ✅ | 0/0 |
| **backoffice** | **main** | **🔴 58** (+42 `ci: pin`) | k3s-prod `prod-sha-def23c6` | last Deploy PROD 2026-08-14 | not checked |

**Backend code is complete on prod.** None of it has booted.

### Branch promotion — the deploy is the merge
- [x] **TASK-EAR-363 train merged** 2026-09-17 04:06–04:34Z: Auth #17, User #42,
      Wallet #54, Order #73, Game #40, Missions #132, Provider #40, api-gateway #75.
- [x] Both hand-resolved conflicts reviewed by an independent reviewer and approved —
      User `prod.yml` (union), Provider `PostgreSQLDSN()` (encoded credentials +
      `PostgresSSLMode()`).
- [x] **Game Deploy PROD failed, then fixed.** Its shared-lib pin `f40cb05` was a
      squash-merged feature-branch commit with a deleted branch — `unknown revision`
      at docker build. Repinned to the identical-tree main commit `fa25ff1`
      (Game #41 → staging, #42 → prod). All nine prod pins are now reachable from
      shared-lib `main`.
- [ ] **🔴 Backoffice prod is 58 feature commits behind `main`** — VIP, redemption
      Diamond pricing (TASK-EAR-329), Player Log Store/gameplay stamps (346/342),
      player-detail truthfulness (326–328), role/staff management and more. The prod
      backend now serves those contracts, but prod admins would still use the
      2026-08-14 UI. `git merge-tree origin/prod origin/main` is clean and keeps
      `k3s-prod/` and `prod.yml`. Open a promotion PR `main → prod`. Its lane is GHCR +
      Argo CD (`games-labs-backoffice-prod`), not ECS, so it is not cost-gated the
      same way.
- [ ] Keep the dry-run-and-inspect step on every train: `staging` still carries a
      stale `prod.yml`, and a conflict resolved toward staging silently drops prod
      fixes.
- [ ] **Pin shared-lib to merged `main` commits only.** Add a CI or review check —
      a feature-branch SHA builds until someone deletes the branch.

### Secrets and configuration
- [ ] **Wallet — 11 payment secrets missing** (Stripe ×6, Ubit ×5). No player can pay.
- [ ] **Provider — 31 game-integration secrets missing** (GGSOFT 8, AFB 6, IDG 5,
      ONEUP 5, VP 5, own auth 2). No game can launch. Rotate `AFB_SIGNATURE_KEY`
      first; TASK-EAR-269 is still blocked.
- [x] Order `SMTP_*` in the `production` environment (2026-09-16).
- [x] ~~Audit the remaining services' `production` environments~~ — Order, Auth,
      User, Logs, Missions, Game and api-gateway have no must-provision gap.
- [x] ~~`USER_HTTP_URL` renders a namespace-less host~~ — fixed; `api-gateway-prod:17`
      renders `games-labs-user-service.games-labs-prod.local:8085`. The old secret
      is unused and can be deleted.
- [x] ~~`WALLET_INTERNAL_TOKEN` not wired for prod~~ — set 2026-09-17 in all five
      repos and re-rendered (wallet:18, order:22, user:17, missions:20, provider:18).
      One 64-character value, hash-compared, different from staging. Wallet stays
      **Phase A (log-only)** with `ENFORCE=false`.
- [ ] Before **Phase B**: confirm Game does not call Wallet's HTTP mux, because it
      has no token wiring.
- [x] `VIP_REWARD_CLAIM_ENABLED` renders `false` on `user-prod:17` (D7).
- [ ] Email footer content (`REDEMPTION_EMAIL_*`, `EMAIL_*`) is unset → the
      support/social block is omitted. Optional.
- [ ] **Plaintext credentials in task-definition env:** `RABBITMQ_URL`,
      `SMTP_PASSWORD` (Auth, Order) and now `WALLET_INTERNAL_TOKEN`. TASK-EAR-349
      is blocked on Secrets Manager / IAM authority. Decide ship-then-rotate or wait.
- [x] Prod DB credentials resolve from Secrets Manager on all eight backends.

### RabbitMQ
- [x] Separate prod broker (devops, 2026-09-15). `RABBITMQ_URL` set in all eight
      `production` environments.
- [x] **Same Contabo host, separate container** (operator, 2026-09-17). Data and
      queues are isolated; the host failure domain is shared and transport is
      plaintext. Accepted for launch.
- [x] **All eight prod task definitions render one fingerprint**, and it differs
      from every staging service (after Game `:22`, 2026-09-17).
- [ ] Queues exist on the new broker — only after first boot.
- [ ] End-to-end: one `player.activity` on prod reaches Missions-prod and **not**
      Missions-staging. TASK-EAR-309's `status.yaml` is stale; close it after this.

### Migrations
- [x] Five migrations in the train, all replay-safe: Auth `014`, User `018`,
      Order `043`/`044` (additive, no DROP pair), Wallet `019` (DROP+ADD CHECK).
- [ ] Wallet `019` re-validates its CHECK with an `ACCESS EXCLUSIVE` lock every boot.
      Harmless at catalog size.
- [ ] **None have run** — they run at first boot. Watch Auth, User, Order and Wallet
      boot logs.

### Scale-up
- [ ] **Operator approval to run prod** (cost-gated; also covers starting RDS).
- [ ] **🔴 Widen the Application Auto Scaling target first.** All nine services have
      `MinCapacity 0 / MaxCapacity 0`, so a bare `desiredCount` change can be pulled
      back to 0.
- [ ] **Ask devops whether a start/stop schedule still exists.** The documented
      09:00–20:00 weekday scale-up did not fire on 09-16 or 09-17. `vestearth`
      cannot read scheduled actions or EventBridge. A schedule coming back would
      boot everything at once, out of order and unsupervised.
- [ ] **Auth before User**, always.
- [ ] Order: Logs (non-money broker smoke) → Auth → User → Wallet → Order → Game →
      Provider → Missions → **api-gateway last**. Each to a completed deployment with
      a running task before the next. Confirm queues on the new broker before the
      gateway admits traffic.
- [ ] **Provider first boot:** the DSN is now `sslmode=require` (was `disable`).
      Confirm `pgxpool.New` and migrations succeed. If TLS is refused: set the
      `POSTGRES_SSLMODE` production secret to `disable` and re-run Deploy PROD, or roll
      back to `:16` (pre-train, also loses TASK-EAR-275).
- [x] ALBs `gamelabs-alb-prod` / `provider-alb-prod` are `internal` and active; public
      entry is `api-gateway.gameslabs.app` via API Gateway HTTP API. Re-check the VPC
      link once the gateway runs.

### Rollback
The new revisions have never run, so the previous ones are **last registered**,
not last-known-good. The last supervised boot was TASK-EAR-339 (2026-09-09).

| service | new (untested) | roll back to |
|---|---|---|
| Auth | `:25` | `:24` |
| User | `:17` | `:15` |
| Wallet | `:18` | `:16` |
| Order | `:22` | `:20` |
| Game | `:22` | `:21` |
| Missions | `:20` | `:18` |
| Provider | `:18` | `:16` |
| Logs | `:12` | — (unchanged) |
| api-gateway | `:17` | `:16` |

- [ ] Never roll back a migration; all five are additive.
- [ ] Broker rollback is config only: restore the previous `RABBITMQ_URL`, then
      redeploy.
- [ ] `wait-for-service-stability: true` stays on.

### Observability before traffic, not after
- [x] All nine `/ecs/<service>-prod` log groups exist and match their task definitions.
- [ ] Missions `player.activity` still requeues on one Nack path and has **no DLQ**.
- [x] Swagger is off on prod (`ENABLE_SWAGGER=false`).
- [ ] `vestearth` lacks `logs:DescribeLogStreams`, `rds:Describe*`, `events:*` and
      `scheduler:*`. Use an operator with CloudWatch Logs read for boot supervision.

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

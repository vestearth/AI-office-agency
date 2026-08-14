# TASK-EAR-265 — Are Wallet's and Order's container ports reachable from outside the VPC?

**Answered:** 2026-08-14 · Claude advisory lane · no application code changed · **no probe
traffic sent to any service.**

## 0. Read this before using the verdicts

**No live AWS access was available.** The `aws` CLI is not installed and there is no
`~/.aws`. Nothing below is a live observation of AWS state. Verdicts rest on (a) a dated
infrastructure snapshot in `aws-deploy/`, and (b) repo IaC + GitHub config read via `gh`.

The only network calls were `gh` API reads and two DNS lookups of hostnames already
recorded in TASK-EAR-257. No connection was opened to any service port.

| Source | Date | Staleness at 2026-08-14 |
|---|---|---|
| `aws-deploy/SparqLab_Infrastructure_Report_—_2026-06-24-v1.md` | 2026-06-24 | **~7.5 weeks** |
| `aws-deploy/ECS/*.md` | 2026-07-10 | ~5 weeks |
| GitHub secrets / variables / run history | live | current |

`aws-deploy/README.md:3` scopes the `ECS/*.md` docs to **staging**, so nearly every **prod**
fact traces to the single 2026-06-24 snapshot. Prod verdicts are correspondingly weaker.

## 1. Direct answer

| Service | Env | Reachable from outside the VPC? | Confidence |
|---|---|---|---|
| Wallet (HTTP 8084) | staging | **No** | High |
| Wallet (HTTP 8084) | prod | **No** | Medium-high |
| Order (HTTP 8087) | staging | **No** | High |
| Order (HTTP 8087) | prod | **No** | Medium-high |

**The assumption FINDING-5 and FINDING-6 were ranked on holds.**

## 2. Evidence

### 2.1 No target group exists for Wallet or Order — decisive

The infrastructure report contains a **closed** target-group inventory, declared count 5
(`:878`, table `:883-927`): `gamelabs-api-tg-prod` (8080), `provider-tg-prod` (80),
`gamelabs-api-tg-dev` (8080), `provider-tg-dev` (8080), `sparqlab-development-tg` (80).

No Wallet/Order target group; nothing on 8084/8087/50054/50051. **A listener rule cannot
forward to a target group that does not exist.** Because the inventory declares its own
count, this is evidence of absence rather than absent evidence.

### 2.2 No ALB listens on those ports; the gateway ALB is internal

Five ALBs (`:833-865`). Only **`provider-alb-prod` is internet-facing** — every other one,
including both gateway ALBs, is internal. Public path is
`Cloudflare → API Gateway HTTP API → VPC Link → internal ALB :8080 → api-gateway`.

Per-service checklists use an explicit `Public` field — api-gateway "ใช่", Auth "ไม่".
**Wallet and Order omit the field**: consistent with internal-only, but an omission rather
than an assertion.

### 2.3 Security groups: no `0.0.0.0/0` near the ECS tasks

Both prod (`:584-589`) and staging (`:620-625`) ECS SG ingress is **entirely SG-referenced**
— from the ALB SG or from itself. No `0.0.0.0/0`, no raw VPC CIDR. The only `0.0.0.0/0`
ingress in the account is on ALB SGs (80/443) plus two separately-flagged SSH findings that
do not touch ECS tasks.

**⚠️ Two things to carry forward:**

1. **The network control is one console action thin.** `8080–8087 ← ALB SG` is already
   permitted in *both* environments. Attaching a target group + listener rule later would
   expose `/wallets/credit` **with no security-group diff** — no review gate would fire.
2. **Prod is wider than staging**: prod permits `50051–50058 ← ALB SG`; staging does not.

### 2.4 Private subnets, NAT egress, `assignPublicIp` DISABLED

Prod placement diagram (`:1124-1136`) names both services inside
`PRIVATE SUBNET 10.90.128.0/20`. Summary `:1255`: "ECS in Private Subnets: No direct
Internet exposure."

`assignPublicIp`: the strongest evidence is the IaC default — `ecs-bootstrap.yml:62` in both
repos, `ASSIGN_PUBLIC_IP="${ECS_ASSIGN_PUBLIC_IP:-DISABLED}"`. **Caveat:** that is a
*default*, overridable by secret, describing only services created by that workflow — which
never ran (§2.6). Supporting prose is weaker than it appears: the network guide's values are
headed "ค่าที่แนะนำ" (*recommended*) and the service checklist entry is an **unticked box**.

### 2.5 Consumed over private DNS only

Callers reach these ports exclusively through `games-labs.local` Cloud Map names
(`Games-Labs-Order/.github/workflows/staging.yml:106`,
`api-gateway/.github/workflows/staging.yml:113-117`). Cloud Map namespaces are VPC-scoped
and not internet-resolvable; plain Cloud Map registers the **gRPC port only**, so 8084/8087
are not in Cloud Map at all.

### 2.6 The bootstrap IaC never ran — the repo does not describe live state

`gh run list --workflow=ecs-bootstrap.yml` returns **zero runs** for Wallet, Order **and**
api-gateway. The ECS services were created outside CI; `ecs-bootstrap.yml` describes intent,
not reality.

`ECS_TARGET_GROUP_ARN` is absent at every readable scope — **including api-gateway, which
demonstrably is behind a target group.** So its absence for Wallet/Order is *consistent
with* no attachment but does not *prove* it. Org-scope secrets are unreadable (`gh secret
list --org SparqLab` → HTTP 403).

Separately noted: `Games-Labs-Wallet/.github/workflows/prod.yml:19` (and Order's) has
`ECS_CLUSTER: ${{ vars.ECS_CLUSTER || 'sparqlab-development-ecs' }}` — the **prod** lane
defaults to the **dev** cluster, and `gh variable list` is empty at all scopes. Does not
change the exposure verdict (both clusters use private subnets) but means prod/staging may
be less isolated than the two-VPC model implies.

### 2.7 Residual lane: legacy k3s NodePort — dormant, not demonstrably gone

`Games-Labs-Wallet/k3s/service.yaml:14` still declares NodePort `30400 → 8084`; Order's
declares `30807 → 8087`. Both repos still carry `k3s/argocd-app.yaml` with ArgoCD
`automated + selfHeal`. The deploy workflow is labelled legacy and manual-only, and last ran
**2026-06-17**.

**Dormant is not decommissioned.** If that cluster still runs with selfHeal, a June-vintage
Wallet still serves 8084 on NodePort 30400 — a build predating every fix in this sweep, with
the same unauthenticated mux. **This is the weakest link and the one gap this task could not
close.**

## 3. What could NOT be determined, and the access needed

| # | Open item | Access needed |
|---|---|---|
| 1 | Live ALB listener rules | `aws elbv2 describe-rules` per listener |
| 2 | Live `assignPublicIp` | `aws ecs describe-services` |
| 3 | Live subnets for the four services | same call |
| 4 | Whether any LB is attached **now** | same call → `loadBalancers[]` |
| 5 | Live SG rules vs the snapshot | `aws ec2 describe-security-group-rules` |
| 6 | **Contabo k3s cluster status** (§2.7) | `kubectl get svc,deploy -A`, or teardown confirmation |
| 7 | Org-level GitHub secrets/variables | org admin on `SparqLab` |

**Highest-value single command** — closes items 2, 3, 4 for all four services, read-only:

```bash
aws ecs describe-services --cluster <cluster> \
  --services games-labs-wallet-staging games-labs-order-staging \
  --query 'services[].{name:serviceName,lb:loadBalancers,net:networkConfiguration}'
```

## 4. Recommended severity re-ranking

**FINDING-5** (OneDay deposit-callback, no signature) — **keep Tier D / HIGH.** Fix before
any re-enablement of OneDay, and make the signature check a hard requirement in the
re-enablement checklist. Its two siblings already verify, so this is a one-of-three
inconsistency and cheap to close.

**FINDING-6** (bare mux, no authorization) — **keep Tier D / MEDIUM**, but treat as durable
hardening rather than closed-and-forgotten, for two reasons:

1. The network control is one console action thin (§2.3) — a future target-group attachment
   would expose it with no SG diff to review.
2. **"Internal-only" has already failed once on these exact services.** The knowledge-base
   lesson *"Internal-Only Is Not A Security Boundary"* documents Order's internal-only
   `ConfirmPaymentHTTP` being reached through an unauthenticated Missions webhook that did
   have a public binding. The rule it derives: ask not "is this handler exposed?" but
   **"who can cause this handler to run?"** This task settled only the first question. An
   indirect-caller sweep remains open and is **not** covered here.

**FINDING-4** (Order `PaymentCallback`, TASK-EAR-267) — same verdict, same confidence, and
caveat 2 applies with particular force since the recorded incident hit its neighbour.

**Net:** nothing here escalates Wallet/Order to incident-grade. TASK-EAR-266 and
TASK-EAR-267 stay urgent hardening.

## 5. 🔴 AFB on production — this inverts TASK-EAR-261's triage

**AFB is code-active on production, its credentials are almost certainly EMPTY there, and
that makes prod worse — not safer.**

First, a correction to the premise: TASK-EAR-257 §4 said production configuration "was not
checked". It was later restated as "staging only", which is a stronger claim than the audit
made.

**Activation is compiled-in — no env var, no DB row, no feature flag.** `cmd/main.go:114`
constructs the AFB adapter, `:143` registers it, `:233-303` maps every route, `:359` handles
dispatch — all unconditional. Grep for `PROVIDERS_ENABLED` / `ENABLED_PROVIDERS` /
`ACTIVE_PROVIDERS` returns **zero hits**. The DB `providers.status` column exists but nothing
reads it to gate anything.

**The credential gap — verified live via `gh`, and independently re-verified:**

| Scope | AFB secrets |
|---|---|
| repo-level | none |
| environment **staging** | all 7 present (`AFB_SECRET_KEY`, `AFB_SIGNATURE_KEY`, …) |
| environment **production** | **NONE** — only `POSTGRES_*`, `RDS_POSTGRES_SECRET_ARN`, `REDIS_*` |

`origin/prod:.github/workflows/prod.yml:28,62` sets `environment: production` and
`:102-107` references all six `AFB_*` secrets against that scope. They do not exist there.
`ecs/build-env-json.sh:9` renders an unset var as `value: ""`, and **prod.yml has no AFB
validation gate** (it validates Postgres and RabbitMQ only), so the deploy succeeds with
empty keys.

**The consequence.** With empty keys, `if secretKey != "" && sigKey != "" && signature != ""`
short-circuits on the *first* term, so `CheckSignatureAFB` **never runs for any request** —
correctly signed or not. On staging the guard is bypassable by *omitting* the header; on
prod it would be **unconditionally off**. Four handlers, not two: GetBalance, Payout,
Adjustment, RoundCheck.

**And Provider is the internet-facing one.** Per §2.2, `provider-alb-prod` is the only
internet-facing ALB in the account, and unlike Wallet and Order it has both that ALB and a
target group. Prod deployed successfully today.

**This inverts the triage.** TASK-EAR-261 assumed "is AFB configured on prod?" decides
incident-vs-urgent, with *unconfigured* being the safer answer. The polarity is backwards:
unconfigured is the **worse** answer. The question that would downgrade it is *"is the prod
Provider service publicly reachable?"* — and the evidence says its ALB is internet-facing.

⚠️ **Contradiction in the source, unresolved:** the same snapshot repo classifies
`provider-alb-prod` as internet-facing in two places (`:840-844`, `html/gamelabsAws.html:399`,
plus a public-subnet diagram) and as **Internal** in a third
(`html/Cost-Report.html:167`). Only a live `aws elbv2 describe-load-balancers` settles it.
That one command is the cheapest thing that closes this.

**Residual that could flip it:** org-level GitHub secrets are unreadable (403). If
`AFB_SECRET_KEY` were defined org-wide it would resolve non-empty. Argument against
(inference, not proof): staging defines them at *environment* level — if an org-level secret
existed, staging would not need its own copy.

**Unrelated, found in passing:** `WIN_CAPTURE_PROVIDERS` is in
`Games-Labs-Provider/ecs/env.names:52` but is **never exported by `origin/prod:prod.yml`**
(staging exports it). It renders empty on prod → win capture is **OFF on production**,
regardless of what EAR-192/194 shipped.

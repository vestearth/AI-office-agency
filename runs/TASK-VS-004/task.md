# TASK-VS-004 — VerifySlip multi-merchant fairness (measure, then decide)

## Context

Follow-up to TASK-VS-003 (knowledge-base Review Queue, "VerifySlip multi-merchant
fairness"; vault note `10 Projects/VerifySlip/Verify Capacity 600-1200 Per Minute — 2026-09-24`).
Production verifies at about 1100/min with 0 5xx, but every capacity run used
**one API key**. The KBank attempt budget is a single 1200/min Redis sliding
window that all merchants share.

## Goal

1. Build a multi-key load test (5–10 API keys: one heavy merchant and several
   light ones) that reports results per key. **No live traffic until the
   operator approves.**
2. Put the fairness-policy options in front of the operator, with the change
   points in slip-system and slip-api, so the operator can decide.

## Verified facts (2026-09-25, read from source and ECS)

### slip-api admission

Source: `internal/handler/middleware/rate_limit.go`, in-memory, **per task**.

- Each branch (API key) has a token bucket of `RATE_LIMIT_RPS=20`, burst 20.
- A process-wide global bucket is also 20 rps.
- `denyUnfair` already applies an **equal share per task**: when two or more
  branches hit the same task within 1 s, each gets `ceil(20 / active)` per
  second.
- Production runs 3 tasks, so global admission is about 3,600/min, three times
  the bank budget. The share threshold is therefore unrelated to the real
  bottleneck, and it depends on which task the load balancer picks.
- No `RATE_LIMIT_*` variables are set in `slip-api-production:31` or
  `slip-api-staging:70`, so the defaults apply. Staging runs 1 task.
- On an admission 429, a live request overflows to the queue (202). A
  `test:true` request gets 429.

### slip-system bank path

Source: `internal/repositories/kbank.go:486-506`. Every KBank HTTP attempt,
including each retry, passes three shared gates:

1. A per-task local rate, `RATE_PER_SECOND=10`.
2. A per-task bulkhead, `CONCURRENCY=18`.
3. The shared Redis ZSET `slip:bank-attempt:kbank:<host>` at 1200/min.

All three return `429 "bank rate limit exceeded"`. slip-api returns that 429
**synchronously**; it is not queued.

### slip-system already knows the merchant

`internal/handler/grpc/bank.go:58` requires the `x-merchant-id` metadata, and
it also receives `x-branch-id`.

- Every slip-api verify path attaches both through `VerifyBank`
  (`internal/core/service/verification.go:228`): HTTP, gRPC, queue worker,
  payment, and LINE webhook.
- So a per-merchant bank budget **needs no proto change**. The limiter just
  has to receive the ID.

### Staging is isolated from production

| Service | Redis | KBank host | Budget | `RATE_PER_SECOND` |
| --- | --- | --- | --- | --- |
| `slip-system-staging:24` | `upslip-redis-dev` | `openapi-test.kasikornbank.com` | 1200 | 6 |
| `slip-system-production:20` | `upslip-redis-prod` | `openapi.kasikornbank.com` | 1200 | 10 |

A staging run therefore does not touch the production budget.

### `test:true` on production still spends the real budget

The limiter key comes from the configured base-URL host, not from the sandbox
URL. So a production `test:true` run slows down real merchants.

### Git drift

- slip-api `origin/prod` is 29 commits ahead of `origin/main`. The PR #15 lock
  fix `3910784` is in `prod`, not `main`.
- slip-system `origin/prod` is 14 commits ahead of `main`.
- The three files read here are identical on `main` and `prod`. Pick the
  implementation base deliberately.

## Deliverable 1 — multi-merchant load test (done, not run live)

The files are in `jaview/60 Loadtest`, uncommitted, on `main`.

- `upslip-verify-multi-merchant.js`
  - One `ramping-arrival-rate` scenario per API key, with phases
    baseline → saturate → recovery.
  - Each key gets a **disjoint slip slice**, and distinct keys are enforced.
  - Every response is tagged with `{merchant, role, phase, status, reason}`.
  - 429s are split by body text: `bank_budget`, `admission`, `api_inflight`,
    `quota`, and `unknown`.
  - A 202 is followed to its terminal queue state.
  - `payload_source: synthetic` is allowed only with `VERIFY_MODE=test`.
- `run-upslip-verify-multi-merchant.sh`
  - Resolves `merchants.json` into `plan.json`, with offsets and VUs sized
    from the peak rate.
  - Preflight checks: 2–10 merchants, at least one heavy and one light, every
    key present and distinct, and enough fresh slips.
  - **Refuses any non-localhost `BASE_URL` unless
    `LIVE_APPROVED=TASK-VS-004`.**
  - `DRY_RUN=1` produces the plan only.
  - Writes `per-merchant.csv` and `report.md`, one row per merchant × phase.
- `merchants.example.json` is the template. `merchants.json` is gitignored,
  and API keys go in `.env`.
- The `60 Loadtest.md` README has a new section for this.

### Verification (local only)

- `node --check` and `bash -n` pass.
- The preflight guards were exercised:
  - A non-local URL is refused.
  - A shared key is rejected.
  - The example plan needs 4,384 slips, and the tracked fixture has 995.
- A k6 v2.3.0 smoke run against a localhost mock with a shared 120/min budget
  and no fairness passed. Report columns filled correctly; 0 dropped
  iterations.
- In that run, the light merchants fell to 46–50% answered during saturate,
  which is the starvation signal the real run is meant to detect.

### Proposed run order (each needs operator approval)

1. **Staging, cheap.**
   - Create 8 staging branches with API keys and large quotas.
   - Temporarily lower staging `BANK_ATTEMPT_LIMIT_PER_MINUTE`, for example
     to 300, so a small synthetic load saturates it.
   - Run with `payload_source=synthetic` and `VERIFY_MODE=test`.
   - Caveat: staging slip-api has 1 task, so `denyUnfair` sees all traffic
     and fairness looks better than on 3-task production. Read the
     `429_admission` column separately.
2. **Production, confirmation only.** A short window, about 4.4k fresh slips
   for the example plan, run off-peak.
   - Pre-check that both services report rollout `COMPLETED`.
   - Afterwards, tally CloudWatch the same way as in TASK-VS-003.

## Deliverable 2 — fairness policy options (operator decision)

Budget B = 1200/min. It is shared with LINE and payment traffic, because they
use the same `VerifyBank` path.

| | A. Per-merchant cap | B. Guaranteed minimum share | C. Weighted fair share |
|---|---|---|---|
| Rule | Merchant i ≤ cap(tier) per minute, plus global ≤ B | Every recently active merchant is guaranteed floor F per minute. Above F, a merchant may borrow only from headroom not reserved for other active merchants. | At saturation, each active merchant gets B × wᵢ / Σw(active). Below about 80% utilization there is no limit. |
| Light merchants protected at saturation? | Only if Σcaps ≤ B, which wastes capacity. Oversubscribed caps give no guarantee. | **Yes, up to F.** | **Yes**, in proportion to weight |
| Uses idle capacity | ❌ The heavy merchant is capped even when the budget is idle | ✅ (except the reserved headroom) | ✅ fully |
| Complexity (Redis Lua) | Low: one extra ZSET per merchant | Medium: an active-merchant ZSET, Σfloor, and a borrow check | High: active set plus weight sum, recomputed or maintained atomically on every call |
| Explaining it to merchants | Easiest ("plan X = N/min"), and sellable | Medium ("at least F/min guaranteed") | Hardest (your limit changes with other merchants' load) |
| Needs tier data | Yes (packages have no rate field) | No (one global F) | Yes for weights; equal weights work without it |
| Main risks | Picking caps; LINE merchants need caps too | Many active merchants × F > B means floors can't all be honoured, so cap ΣF at, say, 50% of B. The heavy merchant starts seeing 429 at B minus reserved. | Behaviour is hard to predict and test. It also duplicates slip-api's per-task `denyUnfair`, but with different numbers. |

**Recommendation: B.** It is the only option that directly meets the closure
criterion (light merchants keep their service level while a heavy merchant
saturates) without tier data or a schema change. It also stays
work-conserving. A can be added later as a commercial plan limit, and C
remains a later refinement if tiers get weights.

### Other decisions needed alongside the policy

1. **Fairness unit.** Choose the merchant (`x-merchant-id`) or the
   branch/API key (`x-branch-id`, which is what slip-api admission uses).
   Recommendation: the merchant. Otherwise a merchant can open more keys to
   get a bigger share.
2. **Overflow.** Should a live `bank_budget` 429 go to the queue as 202
   (webhook or poll) instead of being rejected? This affects LINE and webhook
   merchants.
3. **slip-api `denyUnfair`.** Options are:
   - Keep it as-is, a per-task first line.
   - Set `RATE_LIMIT_GLOBAL_RPS` so that 3 tasks ≈ B, which gives
     `RATE_LIMIT_GLOBAL_RPS=7`.
   - Move it to Redis so it applies across the cluster.

   Two fairness layers with different numbers are confusing.
4. **Retries.** Each KBank retry spends budget. Charge retries to the same
   merchant, the likely default.

### Change points

**slip-system**

- `internal/repositories/bank_attempt_limiter.go`
  - Change `Allow(ctx)` to `Allow(ctx, merchantID)`.
  - The Lua script gains per-merchant `KEYS` (a merchant ZSET, plus an
    active-merchant ZSET for B and C) and `ARGV` values (cap, floor, or
    weight).
  - Keep the 1..1200 validation.
- `internal/repositories/kbank.go:492`
  - The call site needs the merchant ID. Carry it in `models.BankVerifyRequest`
    or in the context from `Verify(ctx, request, test)`.
  - Decide whether the per-task `limiter.try()` (`RATE_PER_SECOND`) and the
    bulkhead `acquire()` also need a per-merchant in-flight cap. A heavy
    merchant can fill all 18 slots on a task.
- `internal/core/services/bank.go`: `VerifyBank` passes `request.TenantID`
  down. It is set from `x-merchant-id` at `internal/handler/grpc/bank.go:58`.
- `cmd/main.go:77`: new env config such as `BANK_ATTEMPT_MERCHANT_FLOOR`,
  `..._CAP`, or `..._RESERVE_MAX_PCT`.
- `.github/workflows/deploy.yml` and `deploy-production.yml`: set the new
  variables as **strings** (see the ecs env.names non-string crash lesson).
- `internal/observability/metrics.go`: add
  `result="merchant_limited"`. Do not label by merchant ID, for cardinality
  reasons.

**slip-api**

- `internal/core/service/verification.go:228`
  - Metadata pairs already carry the merchant and branch.
  - For A or C, add a tier or weight, e.g. `x-merchant-tier`.
- `internal/handler/http/bank.go`
  - ResourceExhausted → 429 mapping (~L338, L807), and `overflowOrLimit`
    (L250).
  - If overflow is chosen, route live `bank rate limit exceeded` to
    `queue.Enqueue` with the `Retry-After` from `RetryInfo`.
  - The queue worker (`internal/core/service/queue.go:330/409`) must then
    requeue a bank 429 instead of failing it.
- `internal/handler/middleware/rate_limit.go`: `denyUnfair` and the global
  limit, per decision 3.
- For A or C with tiers: `internal/models/package.go` has no rate or tier
  field. A `packages.bank_rate_weight` column (or similar) is a schema change,
  so the migration ships in the same change.

## Out of scope

- No live or staging traffic without operator approval.
- No deploys or task-definition changes, including the staging budget
  lowering in run step 1.
- No production scaling.
- No limiter implementation before the policy decision.

## Acceptance (closure)

- A measured multi-merchant run in which light merchants keep their service
  level while a heavy merchant saturates. In the saturate phase, every light
  merchant needs:
  - at least 99% bank-answered;
  - 0 × `429_bank_budget`;
  - p95 no more than 1.5 × its baseline p95.
- The decided policy is recorded. Use ADR-VS-0002 if it is a product rule.

## Wave 1 — operator decision 2026-09-25

The operator chose to do these two first. Neither depends on the A/B/C policy.

1. **Bank 429 → 202.** A live `bank rate limit exceeded` (gRPC
   `ResourceExhausted` from slip-system) on a sync verify path goes through
   `queue.Enqueue`. It returns 202 with the `status_url`/`Location` and a
   `Retry-After` taken from `RetryInfo`, instead of a synchronous 429.
   - `test:true` keeps its current 429.
   - Already true on `origin/main`: the queue worker requeues
     `ResourceExhausted` (`internal/core/service/queue.go` `isBankBusy` →
     `requeueBusy`). No worker change is expected, but verify it under a
     saturated budget. A requeued job spends budget again, so check that
     requeues back off instead of spinning.
   - Keep idempotency and duplicate semantics: an `Idempotency-Key` replay and
     a duplicate slip must behave the same as today.
2. **slip-api admission in Redis.** The per-branch bucket, the global bucket,
   and `denyUnfair` are in-memory per task
   (`internal/handler/middleware/rate_limit.go`). Move them to a shared Redis
   so the limits hold across all tasks.
   - slip-api has **no Redis today**: no client in `go.mod`, no config, and no
     `REDIS_*` env on `slip-api-production`.
   - Infra decisions needed before deploy:
     - Which Redis: share `upslip-redis-prod` with a `slip-api:` key prefix,
       or a new one.
     - Network or security-group access from the slip-api tasks.
     - Fail policy when Redis is down. Recommend a fallback to the current
       in-memory limiter rather than failing closed on every verify.
   - New env vars must be strings in the workflows.
   - Limits should stay at today's effective values unless the operator sets
     new ones.

Tests:
- Real Redis and Postgres, local.
- One regression per item, seen failing first:
  - a slip-system 429 returns 429 before the change and 202 plus a queued job
    after;
  - two limiter instances sharing Redis enforce one combined limit, whereas
    today each allows the full limit.

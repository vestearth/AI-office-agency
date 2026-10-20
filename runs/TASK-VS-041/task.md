# TASK-VS-041: slip-system: turn off Redis result cache on staging (keep bank attempt limiter)

- Repo: `slip-system` (runtime config only; no code change)
- Environment: **staging only** (`upslip-staging-ecs` / `slip-system-staging`). Production is out of scope
  until staging acceptance is recorded and the operator approves a prod change.
- Opened 2026-10-19 by the Claude conductor lane at the operator's request ("ปิด result cache ของ
  slip-system (RESULT_CACHE_MODE=off) บน staging ก่อน โดยเช็ค gRPC retry ใน slip-api ให้ชัวร์").

## Why

slip-system uses Redis (ElastiCache `upslip-redis-{dev,prod}`, valkey 9.1, one `cache.t4g.micro`
node, no replica) for two separate things:

1. **Bank attempt limiter** (`internal/repositories/bank_attempt_limiter.go`): one sorted-set Lua
   script per KBank attempt; it keeps the global `BANK_ATTEMPT_LIMIT_PER_MINUTE` budget shared across
   3–10 tasks. It is required whenever the live KBank repository is used (`cmd/main.go` exits on boot
   without Redis). **Not touched by this task.**
2. **Result cache** (`internal/repositories/redis.go`, `RESULT_CACHE_MODE=redis`): per verify it runs
   GET (miss) → SETNX lock → SET result (TTL `RESULT_CACHE_TTL`=5m) → Lua unlock. Key =
   `TenantID + IdempotencyKey`.

Evidence that the result cache does not replay (prod, CloudWatch `AWS/ElastiCache`, node
`upslip-redis-prod-0001-001`, 7 daily sums to 2026-10-19):

- `CacheHits` equals `EvalBasedCmds` on 6 of 7 days and is 6 lower on the other day; with ~2 scripts
  per verify (unlock GET + limiter ZCARD both hit) any replay would push hits **above** EVAL.
- `GetTypeCmds ≈ 3×CacheMisses`, `SetTypeCmds ≈ 6×CacheMisses`, `CurrItems ≈ verify rate × 5 min`:
  every verify writes a result key that is never read again.

Root cause: since slip-api `67ee662` (2026-09-15) `attemptIdempotencyKey()`
(`slip-api/internal/core/service/verification.go:670`) sends `IdempotencyKey = <key>:<requestID>`,
unique per attempt. Durable idempotency lives in slip-api PostgreSQL
(`verification_idempotency_locks` + replay). The slip-system cache costs 4 Redis round trips
(~2/3 of all Redis commands) per verify and returns nothing.

## Retry safety analysis (done before opening)

Paths that resend the **same** `VerifySlipRequest` (same key) to slip-system:

| Path | Same key? | What the Redis cache does today | Without cache |
|------|-----------|---------------------------------|---------------|
| slip-api gRPC client retry | n/a | `grpc.NewClient` has no service config/retry policy (`internal/adapters/slipsystemadt/adapter.go:38`) | same |
| ECS Service Connect proxy retry (2 retries to another host, TASK-VS-028) on an **error** status | yes | errors are never cached (`executeLocked` → `not_cached`); VS-028 measured every failed request hitting KBank on 3 tasks **with the cache on** | same — no change |
| Service Connect retry after a **connection reset mid-flight** (task killed while calling KBank) | yes | retry waits ≤ `REDIS_POLL_TIMEOUT` 12s on the dead task's lock, then returns Unavailable; no replay because the dead task never stored a result | retry calls KBank once more and returns a real result (one extra bank call; quota/record still saved once by slip-api's PG idempotency) |
| slip-api queue requeue on `ResourceExhausted` (`queue.go` `requeueBusy`, same `job.RequestID` + `queueIdempotencyKey`) | yes | error not cached → no replay | same |
| Merchant retry / slip-api request timeout | no (new requestID) | miss | same |

Conclusion: turning the cache off changes no successful-path result. The only behaviour difference
is the mid-flight reset case, which is rare (20s `SHUTDOWN_DRAIN_DELAY` + stopTimeout 60) and
trades a 12s wait-then-error for one extra KBank call. `RESULT_CACHE_MODE=off` returns a nil cache
and `bankService` already bypasses a nil cache (`internal/core/services/bank.go:88,134`).

Readiness: with live KBank, `/health` still pings Redis (limiter dependency) — unchanged.

## Scope

1. Set the GitHub **staging** environment secret `RESULT_CACHE_MODE=off` on `SparqLab/slip-system`
   (`deploy.yml` reads `secrets.RESULT_CACHE_MODE`, default `redis` when `REDIS_ADDR` is set).
2. Dispatch "Deploy STAGING" (redeploys `origin/staging` HEAD; no code change).

## Acceptance criteria

- New `slip-system-staging` task definition has `RESULT_CACHE_MODE=off`; Redis env still present.
- Service reaches steady state; boot log shows `result cache disabled (RESULT_CACHE_MODE=off)` and
  `using live KBank repository`; no crash loop.
- At least one staging verify succeeds end to end after the deploy.
- `upslip-redis-dev` command pattern per verify drops to the limiter only (no `slip:result:*` /
  `slip:lock:*` SET/GET); limiter EVAL still runs.

## Status 2026-10-19

- Done: staging secret set 13:15Z; "Deploy STAGING" run 39258642252 success on `028f51e`;
  `slip-system-staging:30` 1/1 HEALTHY with `RESULT_CACHE_MODE=off` (ev-001). Boot log:
  `result cache disabled`, `using live KBank repository`, no fatal (ev-002).
- In-task probe via ECS Exec (ev-003): `/ready` 200 (Redis ping for the limiter OK); two direct
  HTTP verifies with a fake transRef reached KBank sandbox (`8404`), limiter `granted`;
  `/metrics` has no `slip_system_cache_operations_total` and no `cache_pool_connections`
  (the Redis cache sets that gauge in its constructor, so its absence shows it was never built).
- `upslip-redis-dev` (ev-004): the probe minute shows GET 1 / SET 3 / EVAL 1 = limiter only.
- **Open — `staging_acceptance`:** the slip-system HTTP verify never uses the cache (TenantID is
  empty there), so it does not exercise the gRPC path that changed. Still needed: one verify
  through slip-api staging (`VerifyBankSlip`/`VerifySlip` gRPC) after 13:19Z, then check
  `slip_system_grpc_requests_total` on the task and that Redis shows no extra GET/SETNX/SET
  beyond the limiter.

- 14:16Z check after the operator reported a verify "through the staging app" (ev-005): staging
  ALB `slip-alb` had **0 requests** 13:19Z–14:16Z, `/ecs/slip-api-staging` has 0 log events since
  13:15Z (last one 10:43Z), slip-system has no `grpc_requests_total` series. The verify did not
  reach staging (the API host for staging is `https://api-staging.up-slip.com`, from the
  `slip-front-end-staging` env `NUXT_PUBLIC_API_BASE`). `staging_acceptance` stays pending.
- 14:27Z second report of a staging verify (ev-006): still 0 slip-api-staging events
  14:16Z–14:27Z and 0 `slip_verify` events since 13:15Z, while an unauthenticated
  `GET https://api-staging.up-slip.com/v1/me` at 14:27:27Z was logged within seconds — the log
  path works; the verify did not reach the staging API. Gate still pending.

## Status 2026-10-20

- `staging_acceptance` **pass** (ev-007): 10 verifies reached slip-api staging at 01:13:50Z–01:14:53Z
  (7×200, 409, 422, 400). On task `75fe8042` (td :30, unchanged since 13:19Z 10/19):
  `grpc_requests_total{VerifyBankSlip,OK}=8`; bank calls 10 = 8 gRPC + 2 ev-003 HTTP probes; still no
  `cache_*` series. `upslip-redis-dev` 01:14–01:15Z: GET 8 / SET 24 / EVAL 8 = the 1:3:1 limiter-only
  pattern of ev-004 (the cache would add GET+SETNX+SET+EVAL per verify).
- Open: `knowledge_closeout`. Production change still out of scope (needs operator approval).

## Rollback

Delete the secret (or set `redis`) and re-dispatch "Deploy STAGING".

## Out of scope / follow-ups

- Production change (needs staging acceptance + operator approval; `deploy-production.yml` reads the
  same secret name from the production environment).
- Redis HA (single node, no replica; readiness pings Redis → a Redis outage takes every slip-system
  task out of rotation). Client uses `redis.NewClient` against a cluster-mode `clustercfg.` endpoint —
  works only while there is one shard.
- Removing the result-cache code path.

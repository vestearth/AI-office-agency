# TASK-VS-028: Bank-unavailable outages: one KBank call per request, per-bank alerting, merchant retry guidance

- Type: reliability / bugfix (slip-api, slip-system, infra config)
- Created: 2026-10-16 by the Claude conductor lane at operator request. Claude opens
  this run only; implementation goes to another lane.
- Gates: preset `production`.
- Related: TASK-VS-018 (KBank 8500 → free, retryable 502), TASK-VS-019 (log sendingBank),
  TASK-VS-029 (personal data in logs, found in the same investigation).

## Incident (read-only investigation, 2026-10-16)

KBank's verify API answered `statusCode=8500 "Internal system error - Destination Bank"`
(HTTP 200 body) for slips sent mostly from KTB (bank code 006).

| Window (UTC) | ICT | slip-api 502 | Detail |
|---|---|---|---|
| 2026-10-15 16:11:17 – 16:55:05 | 23:11 – 23:55 | 8,143 | ~185/min avg, peak 245/min at 16:26Z; ~47% of verify calls. Sending banks: KTB 90.6%, then GSB, TTB, BAY, BAAC |
| 2026-10-15 17:23 – 18:37 | 00:23 – 01:37 (10-16) | 45 | trickle, mostly SCB / TTB |

- Same pattern on 2026-10-12 ~23:30 ICT (VS-018: KTB 5,227 of 5,727): two KTB events in four days at the same hour.
- Our side was healthy: no slip-system deploys since 2026-10-13, no stopped tasks, CPU < 3%; slip-api ALB targets healthy, ELB 5XX 0, target 5XX = 8,143.
- Handled as VS-018 intends: free, retryable 502; `SaveWithQuota` is not reached on the `VerifyBankSlip` error (production commit 822a04f), so no record and no quota. Not yet confirmed in the database.
- One merchant / one branch / one integration (user agent `node`) produced all production verify traffic in the window.
- Clear since 2026-10-15 18:37Z.

## What made it worse (ours)

1. **Three KBank calls per failed request.** Every slip-api 502 lines up with exactly 3
   slip-system 8500 lines on different slip-system tasks, ~150–400 ms apart. slip-api's gRPC
   client has no retry policy (`internal/adapters/slipsystemadt/adapter.go`) and slip-system does
   not retry 8500, so the ECS Service Connect proxy (enabled on both services) most likely
   retries gRPC `Unavailable` twice — inferred from timing, proxy config not yet read.
   8,143 failures cost ~24,400 KBank calls (and 7 `429 bank rate limit exceeded` showed our
   own KBank budget under pressure).
2. **Client retry storm without idempotency.** Traffic rose 278 → 386 req/min (+39%) while 200s
   fell ~271 → 197/min: each failed slip was re-sent ~2.5 times. Every request logged
   `verify without Idempotency-Key; retries will call the bank` (`internal/handler/http/bank.go:618`).
   Duplicate-slip 409s afterwards rose 209 → 925.
3. **Breaker blind to it.** 8500 arrives as HTTP 200, so the KBank circuit breaker counts it as
   success (`slip-system/internal/repositories/kbank.go`, `Verify`). A breaker for all of KBank
   would be wrong (one sending bank failed); a per-sending-bank short-circuit could fit.

## Scope

1. One KBank call per request on `Unavailable`: stop the Service Connect retry for this route
   (or return a status the proxy does not retry). Confirm the retry layer first (proxy config
   or stats); do not add a client retry elsewhere.
2. Alerting: a CloudWatch alarm (or metric filter + alarm) on the bank-unavailable rate per
   sending bank, e.g. > 5% of verify calls for 5 minutes, routed to the operator.
3. Merchant guidance: document `Idempotency-Key` and backoff for 502 `bank verifier unavailable`;
   consider a `Retry-After` header on that 502 (contract: additive header only).
4. Optional, decide in review: per-sending-bank short-circuit (fail fast for ~30 s after N 8500s
   for that bank) without blocking other banks.

## Acceptance

- A reproduced `Unavailable` path makes exactly one KBank call per slip-api request (regression
  test or staging evidence counting slip-system 8500 lines per request id).
- The alarm exists and fires on a staged rate (or a documented dry run), and is quiet now.
- Merchant guidance published where integrators read it; any `Retry-After` change is additive.
- Public status mapping, credit policy (502 stays free) and idempotency semantics unchanged.

## Open points (evidence that settles them)

- Retry layer: Service Connect proxy retry configuration or stats.
- Recurring KTB window: KTB status notices; 8500 rate per bank for the 7 days before 10-12.
- Charging: quota history for the affected branch over 16:11–16:56Z (read-only DB query).

## Evidence handling

The investigation's raw log extracts contain personal data and stay out of this run.
Counts above came from paginated `filter_log_events` reads (every page) with the
`vestearth` profile; no AWS writes were made.

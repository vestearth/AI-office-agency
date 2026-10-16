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

## Review (Claude conductor, 2026-10-16) — verified, scope adjustments proposed

Checked against slip-api `origin/prod` 78e47ab, slip-system `origin/prod` 8655585, ECS
and CloudWatch (counts only).

**Confirmed**
- Status chain: KBank `8500` → `kbankUnavailable` (`slip-system/internal/core/services/kbank_normalize.go`)
  → `models.ErrUnavailable` → gRPC `codes.Unavailable` "bank verifier unavailable"
  (`slip-system/internal/handler/grpc/bank.go`) → slip-api `mapVerifyError` 502
  (`internal/handler/http/bank.go` ~809).
- No client retry: slip-api `grpc.NewClient` (`internal/adapters/slipsystemadt/adapter.go`
  ~35) sets no service config / retry policy.
- ~3 KBank calls per failed request: 2026-10-15 16:25–16:27Z, slip-api verify 502 = 466,
  slip-system log lines containing `8500` = 1,453 (ratio 3.1). Matches the claim; line
  count per call not re-derived.
- Breaker blind: `slip-system/internal/repositories/kbank.go` calls `breaker.success()`
  on any HTTP 200 with matching rqUID (~449); 8500 is normalised later, so it never
  counts as a failure.
- Service Connect is enabled on both `slip-api-production` (client) and
  `slip-system-production` (`grpc` port, alias `slip-system:50050`); no timeout or other
  per-route config is set.

**Proposed adjustments**
1. Scope item 1 — the config route is probably not available: ECS Service Connect
   exposes timeouts (`idleTimeoutSeconds`, `perRequestTimeoutSeconds`), not a retry
   policy. First prove the retry layer on staging (one verify forced to 8500 or a fake
   `Unavailable`; count slip-system calls per request id). If it is the proxy, the
   practical lever is the status code: return a code the proxy does not retry for the
   bank-8500 case only (e.g. `codes.Aborted` or `FailedPrecondition` with an
   `ErrorInfo` detail) and add an explicit slip-api case mapping it to the same
   502 + "bank verifier unavailable". Without that slip-api case the default branch
   answers 502 "slip-system request failed" — a public message change. Keep
   `codes.Unavailable` for real transport failures, where a proxy retry is useful.
2. Retry-After on the 502: slip-api already sets `Retry-After` for `ResourceExhausted`
   from gRPC `RetryInfo` (`writeVerifyResult`); reuse that path rather than a new one.
3. Item 4 (per-sending-bank short-circuit): defer until the item-2 alarm has data. All
   prod verify traffic in the window came from one merchant/branch, so fail-fast would
   mostly shorten that client's retries rather than protect other banks, and could hide
   recovery.
4. Order: VS-029 first (active personal-data leak), then item 1 here, then the alarm,
   then merchant guidance.
5. Charging check stays open: confirm with the read-only quota-history query that no
   quota was used for the affected branch 16:11–16:56Z.

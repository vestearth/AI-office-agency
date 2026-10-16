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

## Independent re-check (Claude conductor, 2026-10-16)

See `verification-2026-10-16.md`. All incident numbers re-derived from CloudWatch; the
retry layer is now confirmed (no app retry for 8500 in slip-api or slip-system; each failed
request hit KBank on 3 distinct slip-system tasks; AWS documents 2 Service Connect proxy
retries to a different host). Still open: quota-history DB check; which gRPC code the proxy
does not retry (staging test).

## Implementation — scope item 1 (Claude conductor, 2026-10-16)

Operator asked Claude to implement this task directly (chat 2026-10-16).

- **slip-system PR #11** (5291ac4, `task/TASK-VS-028-bank-unavailable-no-retry`):
  `mapError` / `mapBankError` return `FailedPrecondition` + `ErrorInfo{Reason:
  "BANK_UNAVAILABLE", Domain: "slip-system"}` (same messages) for `ErrUnavailable` and bank
  HTTP 5xx, instead of `Unavailable`. Envoy's gRPC retry conditions (cancelled,
  deadline-exceeded, internal, resource-exhausted, unavailable) do not include it.
  `TestBankUnavailableIsNotRetriedByProxy` replaces the old Unavailable assertion
  (intentional contract change). RED ev-004, GREEN ev-005, suite/race/vet/build ev-006.
- **slip-api PR #72** (185310b): the slip-system adapter maps that status back to
  `Unavailable` with the same message, so HTTP 502, gRPC passthrough, LINE, queue and metrics
  are unchanged; plain `Unavailable` from an older slip-system passes through. RED ev-001,
  GREEN ev-002, suite/race/vet/build ev-003.
- **Deploy order:** slip-api first, then slip-system. Wrong order only changes the 502
  message to "slip-system request failed" (still 502, still free: the error returns before
  any record/quota write).
- **Proof plan (acceptance 1):** staging slip-system with `MOCK_BANK_FORCE_ERROR=unavailable`
  affects only test-mode requests (mock bank); count slip-system calls per slip-api request
  id before/after. Needs operator approval for the staging env change and one test-mode verify.
- Not in this change: item 2 alarm, item 3 merchant guidance/Retry-After, item 4 deferred.

## Review round 1 (independent reviewer, APPROVE WITH NITS) — 2026-10-16

- Code verdict: correct for 8500 / bank 5xx; FailedPrecondition is outside Envoy's gRPC retry
  conditions; all bank-side `ErrUnavailable` sources covered; slip-api is the only consumer;
  deploy order safe both ways; 502 stays free; replacing the old slip-system test is a
  legitimate contract change.
- **Proof method changed:** staging has 1 slip-system task and no per-call log, so a staging
  per-request count cannot show the fix. Use the prod ratio of server-side
  `AWS/ECS GrpcRequestCount` (DiscoveryName=slip-system, ServiceName=slip-system-production)
  to slip-api client requests: 2026-10-15 15:30–15:40Z 2,841 vs 2,834 (≈1.00);
  16:20–16:30Z 8,878 vs 4,257 (≈2.09, re-checked by the conductor). After deploy the ratio
  must stay ≈1.0 through the next 8500 event (acceptance 1, observed in production).
- Follow-ups (not in #11/#72): KBank 429 → ResourceExhausted and result-cache write failure
  after a successful bank call → Internal remain in Envoy's retry list (retry behaviour for
  those undocumented); move `BANK_UNAVAILABLE` into slip-contracts; item-2 alarm must key on
  the app's 8500 log line, not proxy 5xx.

## Deployed — item 1 (2026-10-16)

Order kept: slip-api before slip-system (authz-001 staging, authz-002 prod).
- slip-api #72 merged e3c1b62 → staging 90229ae (td :136) → prod 60ef81d
  (`slip-api-production:95`, steady 14:47 ICT).
- slip-system #11 merged 0562ecb → staging d4b58a0 (td :27) → prod 23e8fae
  (`slip-system-production:23`, steady 15:01:24 ICT).
- Prod verify after both: 200 ×323, 409 ×6, 400 ×1, 502 ×1 at 08:01:54Z with the unchanged
  message "bank verifier unavailable" (end-to-end mapping works). That 502 had no 8500 line
  (other bank-side cause), so its call count cannot be read from logs. 0 ERROR on
  slip-system prod.
- Unrelated noise seen on slip-api staging: a one-minute burst of `/v1/admin/*` 500s
  (auth/admin failures) 07:50–07:51Z, not slip-system calls.
- production_acceptance waits for the next KBank 8500 event: server `GrpcRequestCount` /
  client request ratio must stay ≈1.0 (was ≈2.09 on 2026-10-15).
- Ratio check (ev-008, `AWS/ECS` GrpcRequestCount server / RequestCountPerTarget client, Sum,
  600 s): pre-fix normal 1.00; pre-fix 8500 event 2.09; post-fix normal 08:10–08:16Z
  1,456 / 1,460 = 1.00. The decisive check is the same ratio during the next 8500 event.

## Item 2 — alarm design proposed (2026-10-16), not created

See `alarm-proposal.md`: metric filter on the slip-system 8500 log line (space-delimited
pattern, `SendingBank` dimension; dry run on 10-15 = 25,482 matches, per-bank split matches
the investigation) + 8 per-bank alarms `upslip-prod-bank-unavailable-<code>` (Sum ≥ 50 per
5 min, 2 periods) on `upslip-prod-alerts` → Lark, added to `upslip-infra`
`scripts/setup-prod-alarms.sh`. vestearth cannot create/describe/test metric filters;
needs the operator/admin account. Awaiting operator review.
- **On hold (operator, 2026-10-16):** item 2 paused for cost — new custom metrics/alarms may
  affect the running cost plan. Nothing created; `alarm-proposal.md` kept for later.
  Existing `upslip-prod-api-target-5xx` still pages on large 502 bursts (no bank attribution).

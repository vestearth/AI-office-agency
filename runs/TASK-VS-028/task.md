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

## Implementation — scope item 3 (Claude side session, 2026-10-16)

Merchant guidance + additive `Retry-After`. Not merged, not deployed.

- **slip-api PR #77** (50daf50, `task/TASK-VS-028-retry-after`, base origin/main 104a547):
  the slip-system adapter attaches `RetryInfo{30s}` when it maps `BANK_UNAVAILABLE` back to
  `Unavailable`; `writeVerifyResult` now reads RetryInfo for `Unavailable` as well as
  `ResourceExhausted` (existing path). Verify 502 `bank verifier unavailable` /
  `bank service is unavailable` → `Retry-After: 30`. Status, body, message byte-identical
  (asserted); plain `Unavailable` (transport) gets no header; gRPC callers get an extra
  RetryInfo detail (additive); queue/LINE/metrics unchanged. 30 s: the 10-15 KTB outage ran
  44 min and the client re-sent ~2.5x at once; 30 s caps a bounded client at ~2 tries per
  slip per minute. RED ev-009, GREEN ev-010, build -mod=readonly/vet/test/race ev-011.
- **slip-front-end PR #9** (ea42097 + review fix 3afc113,
  `task/TASK-VS-028-merchant-retry-guidance`): published on the merchant app's `/developers`
  page (`app/features/developers/constants.ts`, `ui/DeveloperStatus.vue`) — the integrator
  docs. Verify tab: `Idempotency-Key` header row (one key per slip, reuse on every retry,
  slip-api regex), 502 rows for both bank-unavailable messages. Status & Errors tab: catalog
  rows + new section "ลองใหม่อย่างไรให้ปลอดภัย" (notes + Node.js example: key per slip,
  honour Retry-After, 3 attempts, timeout/network retry with same key). Claims checked
  against slip-api source (nothing saved on 502 → same key re-calls bank; finished result
  replays; 409 duplicate risk without key). eslint + typecheck ev-013/ev-014 (3 pre-existing
  errors in auth/branches on origin/main too, 0 in developers). Not visually checked
  (page is login-gated).
- **Review (independent reviewer subagent):** #77 APPROVE; #9 APPROVE WITH NITS → 2 warnings
  (409 row said "new key per request"; second message "bank service is unavailable" undocumented)
  and suggestions fixed in 3afc113; round 2 on 3afc113: APPROVE (Node example exercised with a
  mocked fetch: same key on every attempt, waits 5/15 s or Retry-After capped at 60 s, 3 attempts).
  Reviewer nit: merge #9 only after #77 is serving.
- **Merge/deploy order:** #77 first (or together) so the docs' Retry-After claim is true when
  #9 ships. No config, no migration; rollback = revert.
- **Follow-ups from review (not in these PRs):** slip-system maps the deterministic
  "invalid KBank amount" parse error to `ErrUnavailable` (now also gets Retry-After; deserves
  its own reason); queue/overflow jobs that hit bank-unavailable are marked failed permanently
  with no requeue (`slip-api internal/core/service/queue.go` ~340) — slips lost to merchants
  during an outage; 202 overflow response is undocumented on `/developers`; no end-to-end
  test adapter → `VerifyPayload` for the header.

## Deployed — item 3 (2026-10-16)

Operator batch approval: authz-003 (staging) / authz-004 (prod). Re-checked by the item-3
session in ev-015 (ECS primary deployments, images, rollout COMPLETED).
- slip-api #77 merged 43555fc → staging f318a8b (`slip-api-staging:137`, run 38894714319,
  steady 18:45:31 ICT) → prod f1ff0df (`slip-api-production:96`, run 38895982824, steady
  18:56:45 ICT = 11:56:45Z, 5/5).
- slip-front-end #9 merged 290b188 → staging f1dc471 (`slip-front-end-staging:96`, run
  38897294004, steady 19:02:59 ICT) → prod 391ed27 (`slip-front-end-production:56`, run
  38897903188, steady 19:08:11 ICT). Guidance is on the merchant app's `/developers` page;
  it is login-gated (302 → /login), so its content is not publicly verifiable.
- slip-front-end CI typecheck fails on every branch (`features/branches/useBranchCreate.ts:501`,
  `BranchCreateStepPayment.vue:40`, property `autoRenew`; plus `auth/ui/AuthOtpInput.vue:38`
  locally). It predates #9: prod f8b1143 already failed at 10:03Z, and origin/main had the
  same 3 errors before this change (ev-013). Not fixed here.

**Prod after #77 (ev-015, ev-016; 11:56:45–12:10Z)**
- verify: 200 ×4,601, 409 ×100, 422 ×2, 400 ×1, **502 `bank verifier unavailable` ×19**.
  slip-api ERROR lines = those 19 request logs only.
- All 19: user agent `node`, one branch, duration 3,062–3,093 ms; slip-system logged
  **0** `8500` lines and no WARN/ERROR in the window. slip-system has no per-call log, so
  the cause is not visible (one request id followed: present in slip-api only).
- Retry-After itself is not in the request log; covered by the RED/GREEN tests. Client
  behaviour: missing-Idempotency-Key warnings (5,011) ≥ verify requests (4,887), so the
  integration still sends no key. The request log has no slip identifier, so per-slip
  re-sends after a 502 cannot be counted from slip-api; at this volume (≤4/min) no
  traffic spike is visible around the 502s.

**🔴 Finding for item 1 (not caused by #77): ~3 s bank-unavailable 502s began with the
item-1 slip-system rollout** (ev-017, ev-018)
- ~3 s `bank verifier unavailable` 502s on prod: 2026-10-14 06:00–12:15Z **0**,
  2026-10-15 same hours **0**, 2026-10-16 **305**. The first one was at **08:00:00.197Z**,
  inside the slip-system 23e8fae rollout (steady 08:01:24Z). After that the rate is steady:
  64 / 67 / 75 / 87 per hour for 08Z–11Z, about 0.3–0.4% of verify traffic. The rate did not
  change when #77 shipped at 11:56Z.
- Likely cause (not verified): some transient ~3 s failure in slip-system is now mapped to
  BANK_UNAVAILABLE/FailedPrecondition. Before item 1 it was `Unavailable`, and the Service
  Connect proxy silently retried it onto another task, where it usually succeeded. Item 1
  removed that retry, so the failure now reaches the merchant as a free 502. Matching 3 s
  sources in slip-system: KBank `ConnectTimeout`/`TLSHandshakeTimeout` = 3 s
  (`internal/repositories/kbank.go:153-156`). Not the Redis wait, which is 12 s.
- Needs the conductor/operator: confirm the source (slip-system per-call error logging, or
  the server-side `GrpcRequestCount` ratio for 07Z vs 08Z+). Then decide between a narrower
  BANK_UNAVAILABLE mapping (8500 only, keep proxy retry for connect/TLS timeouts) and an
  in-process retry for connect failures. Until then, prod has ~75 extra free 502/h.

**Status:** item 3 is shipped. The prod Retry-After header is proven by tests only; no log
field records it. VS-028 `production_acceptance` stays pending for item 1's 8500 ratio check,
and should also consider the finding above.

## Regression from #11 and fix — slip-system #12 (2026-10-16)

- **Found:** after slip-system 23e8fae (08:01Z) verify 502 "bank verifier unavailable" rose
  from 0–3/hour to 64–104/hour (≈0.4 %); 476/477 took 3.065–3.076 s = slip-system KBank
  timeout 3.05 s (`TIMEOUT`, `RESPONSE_HEADER_TIMEOUT`). #11 had made timeouts and bank 5xx
  FailedPrecondition too, so the Service Connect proxy stopped retrying them on another task
  (those retries mostly succeeded). Conductor's earlier "0 ERROR" check missed these (level
  INFO/WARN 502s) — corrected.
- **Operator decision (chat 2026-10-16):** FailedPrecondition for 8500 only; timeouts / 5xx
  back to Unavailable; PR + test + review, then staging → prod (authz-005 / authz-006).
- **Fix:** slip-system #12 (6a518e6 + nit 05c273c): `models.ErrDestinationBankUnavailable`
  (wraps `ErrUnavailable`) used only for 8500; mappers return FailedPrecondition only for it.
  RED ev-019 (timeouts/5xx were FailedPrecondition on 0562ecb), GREEN ev-020,
  suite/race/vet/build ev-021. Independent review APPROVE WITH NITS (non-8500 mapping
  identical to pre-#11; slip-api unchanged).
- **Deployed:** merged 948b99c → staging 31a2442 (slip-system-staging:28) → prod 3fd91f0
  (`slip-system-production:24`, 3/3, steady 21:20:52 ICT).
- Follow-ups (pre-existing, from review): KBank 5xx retried in-process then by the proxy;
  non-retryable KBank 4xx wrapped as ErrUnavailable; mock bank has no 8500 option.
- **Verified (ev-022):** 4 h of prod verify before 14:20:53Z: 81,928 requests, 502 = 315
  (0.38 %, 310 at ~3 s); 25 min after: 11,254 requests, 502 = 0. GrpcRequestCount
  server/client 14:30–14:40Z = 4,052 / 4,045 = 1.00 (no 8500 event yet, so the item-1
  acceptance still waits for one).

## Operator-accepted closeout — 2026-10-19

- Operator instruction: "จบงาน TASK นี้ก่อนได้เลยครับ". Close the shipped scope;
  item 2 (per-bank alarms) remains cost-deferred and was not created. Optional
  item 4 (per-bank short-circuit) remains deferred. Neither is claimed done.
- Fresh production acceptance, **ev-023**: 2026-10-16 17:50–18:00Z had gRPC
  server/client counts 2,437 / 2,429 (ratio 1.00329), 10 system 8500 logs and
  10 bank-unavailable API 502s. 2026-10-18 19:10–19:20Z (2026-10-19 02:10–02:20 ICT)
  had 1,720 / 1,717 (ratio 1.00175), 29 system 8500 logs and 29 bank-unavailable
  API 502s. Every filtered log page was read. This meets the review-agreed
  approximately-1.0 production ratio criterion; request-level correlation was
  not established by these aggregate counts.
- Live images checked on 2026-10-19 include the changes: slip-system c7a7981
  includes #12 merge 948b99c; slip-api 0e33df5 includes #77 merge 43555fc;
  slip-front-end a7f5d11 includes #9 merge 290b188. ECS deployments were COMPLETED
  with running/desired 3/3, 3/3 and 1/1 respectively.
- Item 3 is shipped. Retry-After remains test-backed; a live header sample and
  authenticated browser check of the merchant documentation were not performed
  in this closeout. Historical follow-ups, including the quota-history DB check
  and queue retry behaviour, remain outside this operator-accepted closeout.

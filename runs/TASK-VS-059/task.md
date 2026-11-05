# TASK-VS-059: KBank timeout 3.05s to ~12s and stop proxy retry of KBank timeouts (billed late successes)

KBank bills every verify it answers successfully, even when slip-system has already given up at
3.05 s. Today we pay for those answers and throw them away, and the Service Connect proxy then
retries the same slip on another task, which is a second billed call. Phase 1 keeps the answer we
pay for (timeout ~12 s, inside the existing 15 s chain) and stops the proxy from retrying a call
KBank may already be billing.

- Type: bugfix / runtime config. Repo: `SparqLab/slip-system` only (decision 1 = A; slip-api is
  unchanged).
- Created: 2026-11-04 by the Claude conductor lane at operator request ("เปิด TASK เฟส 1").
  Claude opens this run only; implementation goes to another lane.
- Gates: `production` preset (`implementation_verification` → `deploy_staging` →
  `staging_acceptance` → `deploy_production` → `production_acceptance`) + `knowledge_closeout`.
- Related: TASK-VS-028 (proxy retry amplification; the slip-system #11 regression and the #12 fix),
  TASK-VS-043 (unavailable-cause log line), TASK-VS-057 (8500 alarm split; it depends on the 8500
  log line), TASK-VS-039 (shutdown drain), TASK-VS-041 (result cache never hits).
  KB: `knowledge-base/Knowledge Base/10 Projects/VerifySlip/Verify Reliability And Privacy Fixes — 2026-10-16.md`.

## Outcome (2026-11-05): deployed, regression found, rolled back

**12 s is not viable with the current merchant. Successor design: TASK-VS-061.**

- Deployed `slip-system-production:28` (`production-sha-82fb802`, PR #21), tasks up 12:15–12:16Z.
- 12:16–12:29Z on `:28`: 5xx 0, `bank_network` 0, `bank_timeout` 0, 13 slow 2xx (12 of them at
  6.2–6.5 s), but **16 slip-api 408s from merchant `84006774…`, all at 7.65–8.02 s**. The same window
  the day before had 0, and the previous 24 h had 1. The merchant appears to give up at about 8 s
  (inferred from logs, not confirmed by the merchant). These slips used to get 200 through the proxy
  retry, so this was a merchant-visible regression of about 0.3 % of verifies. Whether the merchant
  resends is unknown.
- Rolled back on Earth's approval at 12:33:34Z to `:27` (`production-sha-e87a03e`), complete 3/3 by
  12:38Z. 19:36:54–19:45:54 ICT on `:27`: 3,726 200s, 0 408s, 0 5xx, 18 `bank_network`, 18 slow 200s.
  So the 408s came from this change, and the double KBank calls are back.
- **The conductor's analysis was wrong.** It treated one 14.3 s 200 as proof that the merchant waits
  past 12 s and downgraded asking the merchant to a confirmation. The merchant timeout should have
  stayed a blocker. The 408 acceptance check is what caught it.
- **Hazard still open:** `main`, `staging` and `prod` branches all contain the 12 s code, and `prod`
  (`82fb802`) is ahead of what runs. Any push to `prod` or manual workflow run re-ships it.

## What KBank told the operator (2026-11-04)

- KBank's timeout is 65,000 ms. If we stop waiting at 3.05 s and KBank answers successfully at
  4 s, the call counts as a success **and is billed**. KBank recommends a 65 s timeout.
- There is no inquiry or retrospective API. The HTTP response is the only result (their reply says
  "callback", but our integration has no callback).
- KBank does not dedupe. Every successful answer is billed, repeats included.
- The operator expects KBank will not provide per-day or per-month success counts.
- **not_found answers are not billed** (KBank, 2026-11-04). This matches slip-api, which has not
  charged merchant quota on not_found since `c913d3d` (2026-09-28; `verification.go` ~:309 uses
  `Save`, not `SaveWithQuota`). It does not change this task, and there is no cost reason to change
  the 30 s `NOT_FOUND_COOLDOWN`, which protects the attempt budget.
- **KBank bills only `statusCode=0000`** (KBank, 2026-11-04). Every other code is free: 404/4040
  not_found, `rejected` codes such as expired or invalid data, and 8500.
- **What the invoice should count** (for the billing check below):
  - Billed (0000):
    - `verifications` rows with `status=verified`, including the receiver-mismatch ones;
    - post-bank race `duplicate` rows (non-empty `response_payload`);
    - top-up verifies in `payment_transactions`;
    - `not_found` rows that came from a 0000 answer with no `Data`
      (`slip-system/internal/core/services/kbank_normalize.go` ~:78, error code `invalid_slip`);
    - and the unrecorded ones: late 0000 answers after our timeout, plus any 0000 answer that slip-api
      then failed to save (for example the DB `queryTimeout` 504s in the 2026-09-24 14:16 load test).
  - Not billed: `rejected`; `not_found` from 404/4040; pre-bank `duplicate` rows (no bank call); 8500.

## Baseline (read-only, 2026-11-04)

Measured without bank data. Raw dumps (counters only, no personal data) are in
`runs/TASK-VS-059/evidence/baseline/` on the conductor's machine (gitignored).

1. **slip-system in-memory metrics** (`wget -qO- localhost:8080/metrics` via ECS Exec on the 3 prod
   tasks). The tasks started 2026-10-30 22:19Z and were read 2026-11-04 05:04Z, so the window is about
   4.28 days. Counters reset on deploy, so this is a lower bound if autoscaling added tasks that have
   since stopped.

   | Metric | Value |
   |---|---|
   | KBank verify attempts granted (`bank_attempt_admissions_total{result="granted"}`) | 2,078,107 |
   | `bank_calls_total{status="2xx"}` | 2,069,959 |
   | `bank_calls_total{status="network_error"}` | **7,990 (0.38 %, ≈ 1,870/day)** |
   | `bank_calls_total{status="canceled"}` / `"5xx"` / `"oauth_2xx"` | 153 / 3 / 630 |
   | gRPC `VerifyBankSlip` OK / FailedPrecondition (8500) / Unavailable / Canceled | 2,058,288 / 11,670 / 7,993 / 154 |
   | `bank_call_duration_seconds` buckets ≤ 2.5 s / ≤ 5 s | 2,069,396 / 2,078,735 |

   Every `network_error` became gRPC `Unavailable` (7,990 vs 7,993), which the proxy retries. The
   2.5–5 s bucket holds 9,339 calls; minus the timeouts, about 1,350 successes landed in 2.5–3.05 s,
   right at the cut-off. Mean KBank latency on one task is 0.27 s (sum 185,293 s / 692,938 calls).
2. **CloudWatch** `/ecs/slip-system-production`, filter
   `"kbank verify unavailable" "cause=bank_network"` (the TASK-VS-043 line), 2026-11-03 06:07Z →
   2026-11-04 06:07Z: **1,401 lines**. The CLI auto-paginated: the first page alone had 174, and
   four 6 h windows sum to 518 + 469 + 58 + 356 = 1,401. `bank_network` also covers response read
   errors and dial/TLS failures, and the line carries no elapsed time.
3. **TASK-VS-028 (2026-10-16):** 476 of 477 sampled timeout 502s took 3.065–3.076 s, so
   `network_error` is almost entirely the 3.05 s cut-off.
4. **Server/client ratio:** over the 7 days to 2026-11-03, slip-system `AWS/ECS GrpcRequestCount`
   (DiscoveryName=slip-system) exceeded slip-api `RequestCountPerTarget`
   (ServiceName=slip-api-production) by −144 to +2,049 calls per day. That gap is the proxy retries.
5. **slip-api `slip_verify` log, 2026-11-03 07:42Z → 2026-11-04 07:42Z** (counts and `duration_ms`
   only):
   - 1,416 verifies returned 200 after more than 3 s: p50 3.29 s, max 14.3 s; 148 above 3.5 s,
     40 above 5 s.
   - That is almost exactly the 1,401 `bank_network` lines, while only 6 verifies returned 502. So
     nearly every timeout was retried by the proxy and succeeded on the second call, which means
     about 1,400 slips per day cost two KBank calls.
   - The same hour sample shows 21,794 of 21,807 verifies sent no `Idempotency-Key` (warning
     `verify without Idempotency-Key`). A merchant resend therefore always reaches the bank again.
     A resend of a slip that did verify gets 409 with the original slip data
     (`duplicateResponse` → `withVerifiedSlip`).
   - 408 (client gave up): 27 in 24 h, 24 of them under 1 s, one at 5–10 s, one at 11.1 s.

## Why both changes, and why together

- The 3.05 s cut-off discards answers KBank still bills. A longer timeout keeps the result we pay for.
- slip-system sends a KBank timeout as gRPC `Unavailable` (`mapBankError`,
  `internal/handler/grpc/bank.go` ~:116–140). Service Connect retries `Unavailable` on another task,
  so the same slip costs a second billed KBank call.
- **Never ship the no-retry half alone.** slip-system #11 did exactly that on 2026-10-16. The proxy
  retry had been rescuing timeouts, so verify 502s rose from 0–3/h to 64–104/h until #12 put timeouts
  back on `Unavailable`. The longer timeout must land in the same commit and deploy.
- **Why ~12 s and not 65 s:** the whole chain caps at 15 s.
  - slip-api `SLIP_SYSTEM_REQUEST_TIMEOUT` defaults to 15 s (`slip-api/configs/config.go:92`) and is
    not overridden on prod.
  - Service Connect `perRequestTimeout` is unset, so the AWS default of 15 s applies.
  - slip-api HTTP `WriteTimeout` is 20 s (`slip-api/cmd/main.go:304–307`).
  - The gRPC deadline flows into the KBank request (`http.NewRequestWithContext`).

  12 s leaves about 3 s for slip-api, the rate limiter, the shared attempt limiter and the bulkhead.
  65 s is phase 2 (an async/pending design with a merchant contract change), to be decided after
  2–4 weeks of data from this task.

## Scope — slip-system

Base `main`. On 2026-11-04 `origin/main` (cc80e8d) has nothing that `origin/prod` (e87a03e) lacks.

1. **Timeout 3.05 s → 12 s** for `TIMEOUT` and `RESPONSE_HEADER_TIMEOUT`:
   - `.github/workflows/deploy.yml:194–195` (staging) and `.github/workflows/deploy-production.yml:188–189`;
   - code defaults `configs/config.go:36` and `:39`;
   - the fallback in `internal/repositories/kbank.go:158–159`, and the `Timeout` fallback next to it
     if there is one.

   `CONNECT_TIMEOUT` (2 s) and the TLS handshake timeout stay as they are.
2. **Classify the billing-ambiguous timeout.** In the attempt loop (`internal/repositories/kbank.go`
   ~:508–522), find the case where `httpClient.Do` fails with `ctx.Err() == nil`, **after the
   request was written**, with a timeout error (`net.Error.Timeout()`).
   - Recommended detection: `httptrace.ClientTrace{WroteRequest: …}` on the request context.
   - Wrap that case with a new cause class `bank_timeout` (next to `UnavailableBankNetwork`,
     `internal/models/bank.go` ~:199–205), plus a sentinel that `mapError`/`mapBankError` send as
     `FailedPrecondition` + `ErrorInfo{Reason: "BANK_UNAVAILABLE"}` through the existing
     `bankUnavailableStatus` (decision 1).
   - Dial failures, TLS failures, and resets before the write stay `bank_network` / `Unavailable`.
     KBank never received those requests, nothing was billed, and a retry on another task is safe.
   - Fallback if `WroteRequest` is impractical: treat every `net.Error.Timeout()` as ambiguous (dial
     timeouts are 2 s and rare). Record which one you chose in the PR.
3. **Fix the stale comment** on `bankUnavailableStatus` (`internal/handler/grpc/bank.go` ~:145–150).
   It says "Timeouts and bank 5xx stay Unavailable: a retry often succeeds". After this task that
   stays true for bank 5xx only.
4. **Persistent evidence in CloudWatch**, because the metrics are in memory and reset on deploy:
   - Add `elapsed_ms=` to the TASK-VS-043 line for `bank_timeout`
     (`internal/core/services/kbank_normalize.go:39–50`).
   - Log one line per KBank 2xx that took more than 3.05 s, e.g.
     `kbank verify slow: elapsed_ms=%d`. As merged, the line has no `request_id`, is written before
     the body is read, and counts every 2xx including non-`0000` answers, so it is an upper bound on
     the late successes we used to discard, not a count of money saved.
   - Measure elapsed around `httpClient.Do` (`started` already exists in the loop).
   - Do not log transRef, account, name or any slip field (same rule as VS-043). Log KBank `rqUID`
     only after checking it carries no slip data.
5. **Histogram buckets:** `bank_call_duration_seconds` uses `prometheus.DefBuckets`
   (`internal/observability/metrics.go:20`), which jumps 2.5 → 5 → 10. Give it explicit buckets that
   cover the new range, e.g. 0.25, 0.5, 1, 2, 3, 4, 6, 8, 10, 12, 15. Nothing scrapes it, so this is
   safe.

## slip-api — no change

slip-api already maps `BANK_UNAVAILABLE` back to `Unavailable` + `RetryInfo` 30 s
(`internal/adapters/slipsystemadt/adapter.go:81–110`). A timeout therefore reaches the merchant as
the same 502 "bank verifier unavailable" + `Retry-After: 30` as an 8500, with no slip-api deploy.

## Decisions (operator, 2026-11-04 — "Yes, as recommended")

1. **gRPC reason: reuse `BANK_UNAVAILABLE`** (option A).
   - slip-system only. Merchants see the same 502 + `Retry-After: 30` as for 8500.
   - Logs still tell the two apart: `cause=bank_timeout` vs the 8500 line.
   - TASK-VS-057's our-5xx math subtracts only 8500 lines, so timeouts still count as ours there.
     That is correct, because the timeout is our setting.
   - Rejected: option B, a new `BANK_TIMEOUT` reason. It needs a slip-api change and a slip-api
     deploy first, and 504 would change the merchant contract.
2. **Timeout: 12 s** (not 10 s). After deploy, check where late successes land in the new buckets
   before tuning further.
3. **Slow-success log threshold: above 3.05 s.** This counts exactly the calls the old setting
   discarded.
4. **Lane: Claude opens this run only.** Implementation goes to another lane (the default since
   TASK-EAR-337). There is no per-run override to implement it here.

## Traps

- **#11 regression:** no-retry without the longer timeout raises 502s. Same commit, same deploy, and
  roll both back together.
- **Bulkhead:** `CONCURRENCY=18` per task, 3–10 tasks. A slow KBank now holds a slot for up to
  12 s instead of 3 s.
  - Normal load uses about 2 slots per task (mean latency 0.27 s).
  - In a full KBank stall the bulkhead fills about 4× sooner. It then answers 429 immediately:
    `ResourceExhausted`, no bank call, nothing billed, and proxy-retryable onto other tasks that are
    also full.
  - Watch 429s in acceptance. Do not change `CONCURRENCY` in this task.
- **Circuit breaker:** `CIRCUIT_FAILURES=30` consecutive failures open it for 30 s, per task
  (`internal/repositories/kbank_resilience.go`). Timeouts still count as failures. At 12 s each, the
  breaker takes longer to open. Keep counting `bank_timeout` as a failure unless review finds a reason
  not to.
- **OAuth:** the token fetch uses the same client timeout. A slow token fetch plus a slow verify can
  pass slip-api's 15 s, giving `canceled` / 504. This is rare: `oauth_2xx` was 630 in 4.28 days.
- **`MAX_RETRIES=0`:** keep it. With retries above 0, `isRetryableNetwork` (`kbank.go:629`) would
  re-bill a timeout inside the app too.
- **8500 log line:** do not change it (`kbank_normalize.go:31`). The TASK-VS-057 metric filters parse
  it.
- **Merchant resend:** after a 502, a merchant may resend with the same `Idempotency-Key`. slip-api
  stores nothing for a timeout, so the resend calls KBank again, which is another billed call. That is
  out of scope here; `Retry-After: 30` (option A) slows it down.
- **Prod request timeout:** confirm `SLIP_SYSTEM_REQUEST_TIMEOUT` is still unset in the slip-api prod
  task definition. If it is lower than 15 s, 12 s no longer fits. The task definition holds plaintext
  secrets, so filter for that variable name only and never print the whole env.

- **Merchant client timeout (this conclusion was wrong; see Outcome):** a merchant whose own HTTP timeout is below about 12 s
  would give up before we do. If it then resends, that is another billed call.
  - Today one merchant (`84006774…`) sends all API verifies (TASK-VS-057).
  - The logs already show it waits longer than 12 s. Baseline item 5 has 40 successful verifies
    above 5 s and one at 14.3 s that completed as 200. Client disconnects do reach slip-api (the 408s
    at 5–10 s and 11.1 s), so a client that had left would show as 408. The 408s do not cluster at
    any value below 12 s.
  - Asking the merchant for its timeout is a confirmation, not a prerequisite for
    `deploy_production`. Production acceptance item 4 (408 / `canceled` must not rise) catches a
    shorter timeout; if 408s rise, roll back.
  - Baseline for client give-ups: 27 slip-api 408s per day; slip-system
    `bank_calls_total{status="canceled"}` was 153 in 4.28 days, and gRPC `Canceled` was 154.
  - Separate follow-up, not this task: ask the merchant to send `Idempotency-Key` and keep it across
    resends. Without it, every resend calls KBank again.

## Load-test impact (jaview `60 Loadtest`, 2026-09-24 — TASK-VS-003)

Verified capacity: about 1,100/min on the live bank path with 0 5xx and p95 0.6–0.8 s. Above
that, the 1,200/min `BANK_ATTEMPT_LIMIT_PER_MINUTE` budget sheds load as 429.
(Sources: KB `Verify Capacity 600-1200 Per Minute — 2026-09-24.md`, and the jaview
`reports/verify-step-20260924-ladder-*.md` files.)

- **That number does not change.** No call in those runs came near 3.05 s, and the ceiling is the
  policy budget, not the timeout. A re-run is not needed for this task.
- **It does change when KBank is slow.** Rough model: 3 tasks × `CONCURRENCY=18` = 54 slots;
  offered load at the 1,200/min budget (20/s); every call takes the same latency. The bulkhead
  holds while latency × 20/s ≤ 54, i.e. up to about 2.7 s. Autoscaling follows CPU, so a slow bank
  does not add tasks.

  | KBank latency | Today: completed / billed-but-discarded per min | After: completed / discarded per min | After: instant 429 per min |
  |---|---|---|---|
  | ≤ 2.5 s | up to 1,200 / 0 | same | 0 |
  | 4 s | **0 / ≈ 1,060** | ≈ 810 / 0 | ≈ 390 |
  | 8 s | **0 / ≈ 1,060** | ≈ 405 / 0 | ≈ 795 |
  | > 12 s | **0 / ≈ 1,060** | 0 / ≈ 270 | ≈ 930 |

  - Today, every admitted call during a slowdown times out at 3.05 s, gets billed, and frees its
    slot for the next billed call.
  - After the change, the longer hold acts as back-pressure. More slips complete, and the excess
    becomes a fast 429 with no bank call, so nothing is billed for it.
  - The morning 2026-09-24 runs (1,000/min, 504 at med/p95 ≈ 3.05 s, ~860–940 per run) were this
    case on the old config. Those calls were probably billed as well.
- **slip-api is not the new bottleneck.**
  - Since TASK-VS-016 the idempotency lease does not hold a DB connection while waiting on
    slip-system.
  - slip-api's admission limit is rate-based (20 rps per task), not concurrency-based.
  - The repository `queryTimeout` of 3 s applies to DB calls only, not the bank wait.
- **k6 harness:** the request timeout is 60 s and `MAX_VUS = rate/2 + 50`. At 1,200/min with 12 s
  latency, k6 needs about 240 VUs, which the cap of 600 covers, so `dropped_iterations` stays at 0.
- **Do not load-test the slow-bank case on prod.** Every live call is billed, and KBank cannot be
  made slow on purpose. If measurement is wanted, use a fake bank (an httptest server sleeping
  4 / 8 / 13 s) against slip-system locally or on staging. Expect the table above: completed ≈
  54 / latency per second, instant 429 for the excess, and no `Unavailable`.

## Verification and acceptance

- **`implementation_verification`:** write the RED tests first and see them fail on the current code.
  - An httptest KBank that answers 2xx after 4 s. It fails today (3.05 s timeout) and passes with 12 s.
  - An httptest KBank that stays silent past the timeout. Expect `FailedPrecondition` with the chosen
    reason (not `Unavailable`) and the log `cause=bank_timeout elapsed_ms=…`.
  - A dial failure (closed port). Expect it to stay `Unavailable` / `bank_network`.
  - A 2xx slower than the threshold. Expect exactly one `kbank verify slow` line with no slip fields.
  - Then `go test ./...`, `go build -mod=readonly ./...` and `go vet ./...` on the committed SHA, and
    open a PR into `main`.
- **`deploy_staging` / `staging_acceptance`:**
  - The staging task definition env shows `TIMEOUT=12s` and `RESPONSE_HEADER_TIMEOUT=12s`.
  - Boot is healthy.
  - A staging verify through slip-api succeeds.
  - The shutdown drain is still 20 s (VS-039).
- **`deploy_production`:** promote main → staging → prod, each step through a PR (skill
  `verifyslip-promote`). No migration. Choose a quiet window.
- **`production_acceptance`:** wait at least 48 h after the deploy, compare with the baseline above,
  and use counts only.
  1. CloudWatch `cause=bank_timeout` lines per day are far below the old 1,401 `bank_network` lines
     per day. `kbank verify slow` lines per day give an upper bound on the late successes we now
     keep. One call can log both lines, and `bank_timeout` can slightly overcount (a timeout right
     after `WroteRequest` does not prove KBank received the request).
  2. The daily ratio `GrpcRequestCount` / `RequestCountPerTarget` is about 1.00, meaning the proxy no
     longer retries timeouts.
  3. slip-api verify 502s per day (ALB target 5xx minus 8500 lines, the TASK-VS-057 math) are not
     above the week before the deploy.
  4. 429s (bulkhead or attempt limiter) do not rise, and neither do 408 / `canceled` (the merchant
     gave up first).
  5. Record verify p99 before and after. The tail will grow; report it, don't gate on it.
- **Billing check (not a gate):** compare the next KBank invoice count with our stored bank results
  (`verifications` + `payment_transactions`). This needs finance and a read-only prod DB count.

## Staging gap and first-verify-on-prod plan (operator, 2026-11-05)

KBank restricts which slips can be read on staging, so no verify could run through slip-api staging
after the deploy. `staging_acceptance` is therefore `na`, not passed. Staging proved rollout, env,
boot and `/ready` only. **The first real verify on this code happens on prod.** To compensate:

1. Before merging to `prod`, capture a baseline for the same hours on the previous days, counts only:
   `slip_verify` by status, and `cause=bank_network` lines.
2. Deploy outside the evening peak and with the operator available. The deploy replaces tasks in a
   rolling way, so old and new tasks serve together for a few minutes.
3. Check at once after the first new task serves, then to about +12 min (`slip_verify` is high
   volume, so a real signal arrives within a minute):
   - 200s continue at the normal rate, with no gap;
   - 5xx and ERROR lines do not rise, and slip-system logs no `panic` or `fatal`;
   - `cause=bank_timeout` lines appear with `elapsed_ms` near 12,000 and `cause=bank_network` falls;
   - `FailedPrecondition` maps to 502 with `Retry-After: 30`, the same as 8500.
4. Roll back at once on a 5xx spike or a drop in 200s: point `slip-system-production` at `:27`
   (`production-sha-e87a03e`), then revert the merge on the branches.

## Phase 2 decision input (not a gate)

Phase 2 (65 s through an async/pending verify) has no run yet, on purpose. Whether it is worth
building depends on this task's data. Opened 2026-11-04 by operator decision.

1. **Measure 2–4 weeks after `deploy_production`.** Count per day, using counts only and
   all-pages `filter-log-events` on `/ecs/slip-system-production`:
   - `cause=bank_timeout` lines: calls still cut at 12 s. Each may be billed with its result
     discarded.
   - `kbank verify slow` lines: an upper bound on late successes that phase 1 now keeps (all 2xx, not
     only `0000`).
   - Optional: where the slow calls land in `bank_call_duration_seconds`, read through ECS Exec on
     all tasks.
2. **Residual cost per month** ≈ `bank_timeout` per day × 30 × the KBank price per `0000` answer.
   The price comes from the contract or from finance. Cross-check against the KBank invoice when it
   arrives.
3. **Compare with phase 2's cost:**
   - a pending status and a migration;
   - replay instead of 409 for a slip still in flight;
   - an async result (poll or webhook);
   - a merchant API contract change.
4. **Record the numbers and the operator's decision here.** If this task closes before the 2–4
   weeks are up, the knowledge closeout carries this as an open follow-up with the date to
   measure.
   - If phase 2 goes ahead, open it as a design/decision run first, not an implementation run.
   - If it does not, record "phase 1 is sufficient" with the numbers.

## Implementation record (2026-11-05)

- Implemented through Multica SPAR-60 (operator override of decision 4's lane routing: assigned to
  the AI Dev Team squad). Merged by operator approval: `SparqLab/slip-system#19`, HEAD `2256c62`,
  merge commit `20e4e99` on `main`. `staging` and `prod` are unchanged.
- Added beyond the original scope, at the conductor's audit: gRPC shutdown grace 10 s → 15 s
  (`grpcGraceTimeout`, `cmd/main.go`). The old bound was below the new 12 s KBank timeout, so a
  forced stop could turn a slow call into a proxy-retried `Unavailable`. 20 + 5 + 15 + 5 = 45 s fits
  `stopTimeout=60`.
- Also changed: cancel or deadline during the body read now returns `Canceled` /
  `DeadlineExceeded` instead of `bank_network` / `Unavailable`. It is counted as `read_error`, not
  `canceled`, in `bank_calls_total`, so acceptance item 4 must read gRPC `Canceled` / slip-api 408 too.
- Known and left open:
  - connection reset or EOF after the request was sent stays `Unavailable` and proxy-retried;
  - `fetchAndCacheToken` holds `tokenMu` during OAuth, now up to 12 s, while waiters hold bulkhead
    slots (read from code by the reviewer, not run);
  - no CI on the PR; not yet run on ECS, staging, prod or against real KBank.
- Rollback: revert the merge of the whole PR (`git revert -m 1 20e4e99`).

## Rollback

- slip-system: revert the PR and redeploy, which brings back 3.05 s and `Unavailable`. No data or
  migration is involved. Never revert only the timeout and keep the no-retry mapping: that recreates
  the #11 regression.
- slip-api: nothing to roll back (decision 1 = A).

## Out of scope

- 65 s / async verify (phase 2)
- not_found billing and the 30 s `NOT_FOUND_COOLDOWN`
- invoice reconciliation tooling
- `CONCURRENCY` / breaker tuning
- the result cache (TASK-VS-041)

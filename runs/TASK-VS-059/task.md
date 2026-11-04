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
     `kbank verify slow: elapsed_ms=%d request_id=%q`. These are exactly the late successes we used
     to pay for and discard, so their daily count is the saving.
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

- **Merchant client timeout:** a merchant whose own HTTP timeout is below about 12 s now gives up
  before we do. If it then resends, that is another billed call.
  - Today one merchant (`84006774…`) sends all API verifies (TASK-VS-057).
  - Before `deploy_production`, the operator asks that merchant for its client timeout. It should
    be at least 15 s.
  - Baseline for client give-ups: slip-system `bank_calls_total{status="canceled"}` was 153 in 4.28
    days, and gRPC `Canceled` was 154. slip-api logs these as 408.

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
     per day. `kbank verify slow` lines per day show the late successes we now keep.
  2. The daily ratio `GrpcRequestCount` / `RequestCountPerTarget` is about 1.00, meaning the proxy no
     longer retries timeouts.
  3. slip-api verify 502s per day (ALB target 5xx minus 8500 lines, the TASK-VS-057 math) are not
     above the week before the deploy.
  4. 429s (bulkhead or attempt limiter) do not rise, and neither do 408 / `canceled` (the merchant
     gave up first).
  5. Record verify p99 before and after. The tail will grow; report it, don't gate on it.
- **Billing check (not a gate):** compare the next KBank invoice count with our stored bank results
  (`verifications` + `payment_transactions`). This needs finance and a read-only prod DB count.

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

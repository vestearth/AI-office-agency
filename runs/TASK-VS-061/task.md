# TASK-VS-061: KBank capped retry inside the merchant's 8 s limit (successor to TASK-VS-059)

TASK-VS-059 raised the KBank timeout to 12 s with no retry and was rolled back on 2026-11-05: the
merchant gives up at about 8 s, so slips that used to succeed through the proxy retry stopped getting
a result. This task keeps the goal (fewer double-billed KBank calls) and keeps merchants getting an
answer: wait longer on the first call, then retry once inside a fixed time budget.

- Type: bugfix / runtime behaviour. Repo: `SparqLab/slip-system`.
- Created: 2026-11-05 by the Claude conductor lane. Design chosen by Earth ("Yes, capped retry").
- Read first: `runs/TASK-VS-059/task.md`, especially "Outcome", the KBank billing rules, and the
  baseline. Its traps on bulkhead, breaker and OAuth still apply.

## Prerequisite

The 12 s code from TASK-VS-059 was reverted on `main`, `staging` and `prod` on 2026-11-05, and prod runs
`slip-system-production:29` at 3.05 s. The parts worth reusing are no longer on those branches, so take
them from PR #19 (`task/TASK-VS-059-kbank-timeout`): `elapsed_ms`, the slow-call line, histogram buckets,
the `WroteRequest` classification, the 15 s gRPC shutdown grace.

## Evidence and what is still a guess

- Merchant `84006774…` gave up at 7.65–8.02 s on all 16 slip-api 408s (12:16–12:29Z, 2026-11-05).
  **8 s is inferred from logs, not confirmed by the merchant.**
- On 12 s code: 12 of 13 slow 2xx landed at 6.2–6.5 s, and 16 calls were not answered within about
  8 s. This is a 13-minute sample.
- On 3.05 s code, proxy retries mostly succeed quickly: 1,416 slow 200s, p50 3.29 s total
  (2026-11-03/04), 18 of 18 on 2026-11-05.
- Timeouts run at about 80–120 per hour in daytime (`cause=bank_network`).
- KBank bills only `statusCode=0000`, including answers after we stopped waiting.
- Expected effect (estimate): double calls fall from about 100 to about 70 per hour.

## Scope (slip-system)

Proposed starting values; make them env-configurable so they can be tuned without code:

| Setting | Value | Meaning |
|---|---|---|
| Total budget | 7.4 s | Whole KBank verify including retry. Must stay below the merchant limit after slip-api overhead |
| First attempt | 6.6 s | Above the 6.2–6.5 s cluster |
| Retry | 1 | Only for a post-write timeout on the first attempt, capped by the remaining budget |

1. Per-attempt deadline through `context.WithTimeout`. `http.Client.Timeout` and
   `ResponseHeaderTimeout` (`kbank.go` ~:97–99) apply to every attempt alike, so they cannot express
   this; set them at or above the first-attempt value.
2. Retry inside slip-system, not the proxy. Timeouts that end the verify stay `FailedPrecondition` +
   `BANK_UNAVAILABLE`, so the proxy still does not retry. The proxy cannot see the remaining budget.
3. Skip the retry if too little budget remains (start at 300 ms); return `bank_timeout`.
4. Generic `MAX_RETRIES` stays 0. Do not reuse its loop as is: it also retries network errors and
   5xx, and `isRetryableNetwork` would retry more than intended.
5. Log per verify, with no slip fields: which attempt succeeded, `elapsed_ms` of each attempt, and
   whether the retry was skipped. These lines measure double calls, so they are the saving evidence.

## Traps

- **`rqUID`:** the body is built once before `execute`, so a loop retry resends the same `rqUID`. A
  proxy retry used a new one, since the new task regenerates it. Generate a new `rqUID` per attempt
  and check the response against that attempt's value. Do not assume KBank accepts a repeat.
- **Late answer to the first attempt:** it is lost once the deadline passes and may still be billed.
  That is the accepted cost of a retry.
- **Budget accounting:** the budget starts at slip-system, but the merchant's clock starts earlier.
  Measure slip-api time outside the KBank call before trusting 7.4 s (`slip_verify` `duration_ms`
  minus slip-system elapsed), including the DB save after the answer.
- **Attempt budget:** a retry consumes `BANK_ATTEMPT_LIMIT_PER_MINUTE`; a 429 on the retry must return
  a clear result without another bank call.
- **Bulkhead:** the slot is held up to 7.4 s, against 3.05 s plus a proxy retry on another task now.
  54 slots at the 1,200/min budget cover about 2.7 s mean latency.
- **Breaker:** count a verify as one failure only if it finally fails; decide and test it.
- **OAuth:** `fetchAndCacheToken` holds `tokenMu`; a slow token fetch spends the same budget.
- **Staging:** KBank restricts readable slips there, so behaviour cannot be proven on staging. Use a
  fake bank for slow-first-attempt tests.

## Open questions

Ask before `deploy_production`; do not infer the answer from logs again.

1. **Merchant** (answers relayed by Earth, 2026-11-06):
   - Client timeout: "10 s". This does not match the logs: 408s stop at about 8.0 s (157 at 7.88–8.01 s on
     2026-11-05), and slip-api source and its prod workflow have no 8 s setting. **Still open:** what the
     10 s covers and what cuts at 8 s. Keep the 7.4 s budget until this is explained.
   - Resend: on timeout or 502, every 3 minutes, up to 12 times. The merchant can change this. A 408 saves
     no row, so the resend calls KBank again. **Still open:** which statuses trigger it, and how it treats 409.
   - `Idempotency-Key`: the reply was about checking logs and did not answer. **Still open.**
2. **KBank:** why some calls cluster near 6 s and others pass 8 s, and whether that can be fixed on
   their side.
3. **Price per `0000` call:** needed to confirm the saving is worth the risk. If it is not, keeping
   3.05 s + proxy retry is a legitimate outcome and this task closes without shipping.

## Verification and acceptance

- `implementation_verification`, RED first with a fake bank:
  - first attempt answers at 6 s: one call, 200;
  - first attempt silent: exactly two calls, second succeeds, total below budget, different `rqUID`s;
  - both silent: exactly two calls, `FailedPrecondition`, total at or below 7.4 s plus a small margin;
  - too little budget left: no second call;
  - dial failure: stays `bank_network` / `Unavailable`;
  - caller cancel during either attempt: no further bank call.
- `staging_acceptance`: rollout, env and boot only, unless a readable slip exists. Record the gap.
- `production_acceptance`, compared with the same hours before the deploy:
  - **Immediately, for the first 15 minutes: slip-api 408s, including their `duration_ms`. A cluster
    near 8 s means roll back.** The previous normal is about 1 per 24 h.
  - 5xx not above baseline, and 200s at the normal rate.
  - After 48 h: double-call lines per day against `cause=bank_network` lines before, and the proxy
    ratio `GrpcRequestCount` / `RequestCountPerTarget` near 1.00.

## Rollback

Point `slip-system-production` at the revision recorded just before the deploy (`:29` today), then
revert on the branches. Decide the revision again at deploy time.

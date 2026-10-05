# TASK-VS-005 — Don't charge credit for bank NOT_FOUND (BBL/SCB lag slips)

## Closeout — 2026-10-05

The operator directed this task closed while waiting for the customer to report
another problematic slip. Wave 1 items 1–3 were merged and deployed to staging
and production (see `status.yaml`). This closure records the shipped scope; it
does not claim a real-bank NOT_FOUND → same-key retry → VERIFIED test or the
post-deploy production DB counts below. When a suitable customer slip is
reported, open a bounded follow-up for controlled retry testing and billing
reconciliation. Item 4 still needs sanitized BBL/SCB fixtures, and the Wave 2
delayed re-check remains a separate future decision.

## Why

Partner report (2026-09-26): BBL records a transfer at the bank about 2 minutes late, and SCB about 75s late
(p90 118s). A slip verified straight after transfer comes back 404, for ~45% of BBL over 24h
and 3.7% of SCB. Their cascade is Slip2Go → EasySlip → **Upslip (us)**, so these 404s land on us.

- Slip2Go (FAQ) charges only for a real slip, a real slip with a name mismatch, or a fake slip. No charge for not found.
- EasySlip has a documented `SLIP_PENDING` (404) for BBL slips less than 5 minutes old, with "wait and retry".
- **Upslip charges 1 credit for NOT_FOUND.** Estimate is ~15k credits/day on BBL alone.

## Current behaviour (verified on slip-api origin/main f0c3a01, slip-system d547d4a)

- slip-system `internal/core/services/kbank_normalize.go:19`: KBank `404`/`4040` → `StatusNotFound`, returned as a
  **normal response, not a gRPC error**.
- slip-api `internal/core/service/verification.go`:
  - `VerifyBank` (~L274) and `Verify` (~L131) call `SaveWithQuota` unconditionally after the bank responds, whatever the status.
  - `models.QuotaCost()` always returns 1 (`internal/models/quota_history.go:84`).
  - Receiver-mismatch branch (~L265) also charges. It stays charged: the bank did verify the slip.
- Queue/batch `batchOutcomeFromVerify` (`queue.go:~447`): `"404","4040"` → `quotaUsed: true`.
- Duplicate guard `ExistsVerified` only matches `status='verified'` (unique index `verifications_branch_slip_verified_uidx`
  is `WHERE status='verified'`). A retry after not_found is therefore **not** blocked as duplicate. Good.
- **TRAP, idempotency replay:** `replayBankVerification` returns the stored record for the same `(branch, Idempotency-Key)`.
  A partner retrying with the same key gets the cached not_found forever and never re-hits the bank. The queue's key is
  also fixed per job (`queueIdempotencyKey` = `queue_<key|jobID>`).
- `requeueBusy` sleeps a worker goroutine (≤1 min). It is not usable for 2–5 minute delays.
- **TRAP 2, slip-system result cache (review 2026-09-26, verified):** slip-api forwards `attemptIdempotencyKey(clientKey,
  requestID)` (`verification.go:224`, `:626`), which is the **client key unchanged** when one is given. slip-system
  `VerifyBank` (`slip-system/internal/core/services/bank.go:81`) caches every non-error result, 404 included, under
  `(tenant=x-merchant-id, key)` for `RESULT_CACHE_TTL` (default 5m, `configs/config.go:50`). The cache digest includes
  `rqUID` and `rqDt`. For the same key:
  - identical body → cached not_found is replayed for 5 minutes;
  - new `rqDt` → `ErrIdempotencyConflict`.
  Either way the bank is never asked again. **Runtime (AWS, 2026-09-26):** `slip-system-production:20` and
  `slip-system-staging:24` both set `RESULT_CACHE_MODE=redis` with no TTL override, so 5m is live. x-merchant-id is
  always sent, so the cache applies on every path.
- **Quota pre-check (review, verified):** `VerifyBank` checks `assertQuotaAvailable` before the bank call
  (`verification.go:219`), and so does HTTP `VerifyImage` (`handler/http/bank.go:378`, QRCode action). A branch with a
  zero balance is rejected before anyone knows the slip is NOT_FOUND.
- **Legacy rows (review, verified):** existing not_found rows already carry `idempotency_key`. The unique index
  `verifications_branch_idempotency_uidx (branch_id, idempotency_key) WHERE idempotency_key <> ''` (migration 027)
  means that "skip replay" alone makes the later verified insert with the same key hit 23505, which is mapped to
  `ErrDuplicateSlip` (`repositories/verification.go:166`). That is wrong: it tells the partner "duplicate" for a genuinely new success.

## Scope — Wave 1 (no schema change, ship first). Behaviour LOCKED 2026-09-26

**Readiness split (2026-09-26 review):** items 1–3 are READY for dev. Item 4 (`retryAfterSeconds`) is BLOCKED until real
BBL and SCB slip QR fixtures exist to confirm the bank codes. Items 1–3 ship without item 4; item 4 follows as its own
PR once fixtures land.

1. **NOT_FOUND is free.** In `VerifyBank` and `Verify`, when the bank result status is NOT_FOUND
   (`VERIFICATION_STATUS_NOT_FOUND` / statusCode 404|4040), persist via `vr.Save` (no quota) instead of `SaveWithQuota`.
   Keep the record, since history and dashboards count `not_found` as Failed.
   Batch: `batchOutcomeFromVerify` 404 → `quotaUsed: false`.
   REJECTED (fake or expired) stays charged, like Slip2Go.
   **Zero balance: LOCKED = the pre-check stays.** Free NOT_FOUND only applies when the branch has ≥1 available quota;
   the check reserves nothing and consumes nothing. A balance-0 branch gets the existing quota error before the bank call,
   on both `VerifyBank` and `VerifyImage`. This keeps bank spend bounded to paying branches. Operator may revisit later;
   it is out of scope here.
2. **Idempotency must not pin a not_found. LOCKED, all three layers:**
   a. **slip-system key per attempt.** slip-api forwards `<clientKey>:<requestID>` to slip-system, and `requestID` alone
      when there is no client key. requestID is unique per inbound HTTP request (generated if absent), so in-request
      dedupe survives but a new partner request gets a fresh slip-system key: no 5-minute replay and no digest conflict.
      The queue path gets the same `<queueKey>:<job.RequestID>` via this same function, with no queue change in Wave 1.
      That is safe today because a NOT_FOUND **completes the job on that attempt**; nothing re-verifies it. A job can
      still reach slip-system more than once, but only through the bank-busy path: `requeueBusy` (`queue.go:329`)
      requeues on a ResourceExhausted *error* and calls again with the same key. slip-system never caches errors, so that
      re-call does reach the bank. A per-attempt key is therefore needed only once Wave 2 re-checks after a *result* (404). `QueueJob`
      (`internal/models/queue.go:49`) has no attempt counter, so the per-attempt `:a<n>` key moves to **Wave 2** together
      with the delayed re-check that needs it. The slip-api-level idempotency (DB unique on the client key) is unchanged.
   b. **New not_found rows are stored with `idempotency_key=''`.** Keep `request_hash`/`response_payload` for audit.
   c. **Legacy rows are released on encounter.** In `replayBankVerification` and `replayVerification`, if the record found
      by key has `status='not_found'`, then while still holding `AcquireIdempotencyLock` run
      `UPDATE verifications SET idempotency_key='' WHERE id=$1 AND status='not_found'` and fall through to the bank.
      No migration, no backfill. Rows never retried keep their key harmlessly.
3. **Abuse guard (free calls still cost us the KBank budget, 1200/min shared, see TASK-VS-004).** Add a negative cache:
   if the same `(branch, sending_bank, trans_ref)` returned not_found less than `NOT_FOUND_COOLDOWN` ago (default 30s,
   env string), answer not_found from the stored record without calling the bank, also free. Use the existing
   `verifications_branch_created_idx` plus a trans_ref filter. If EXPLAIN shows a seq scan on prod-size data, add
   `CREATE INDEX IF NOT EXISTS` in a new migration (idempotent, replay-safe).
4. **Retry hint (additive contract field). LOCKED placement:** a **top-level** `retryAfterSeconds` (int) in the 404
   JSON, a sibling of `statusCode`/`statusMessage`/`data` in `VerifyBankResponseBody.MarshalJSON`
   (`internal/models/verification.go:~187`). Mirror it in the `Retry-After` header. Present **only** when
   `statusCode=404` (`omitempty`); 200/409/422 bodies stay byte-identical. Values: BBL 120, SCB 90, other banks 60.
   The HTTP status stays 404.
   **Bank codes are UNCONFIRMED:** test fixtures only contain `"004"` (KBank). Before hardcoding BBL/SCB, capture one real
   BBL and one real SCB slip QR payload, and assert the parsed `SendingBank` value in a test.
   **PII: never commit a real QR as-is.** Build a sanitized fixture: keep the sending-bank field and the payload
   structure/CRC validity the parser needs, and replace transRef and any account or name fields with synthetic values.
   Keep the raw capture out of the repo.
   Run `api-contract-review`, and update postman and docs.

## Wave 2 (RECOMMENDED: partner is migrating 100% to Upslip, 2026-09-26; needs a migration)

Once the partner moves all traffic to us, every BBL slip lands on Upslip. We should own the "bank hasn't recorded it
yet" window instead of making each partner write retry logic.

Queue a delayed re-check for not_found: add a `next_attempt_at` column to `verification_queue` (idempotent ADD with a
marker guard, per the migrations lesson), add a persisted `attempt` column (same marker-guarded migration) and send the per-attempt slip-system key `<queueKey>:<requestID>:a<attempt>`, retry at +2/+3/+5 min,
then finalize not_found (free). The webhook fires only on the final outcome.

## Tests (RED first, test-integrity rule)

- `VerifyBank` with mock slip-system → NOT_FOUND: quota balance unchanged, record persisted with status `not_found`.
  Seen failing on main today.
- Same with REJECTED → still charges 1 (regression guard).
- Receiver mismatch → still charges 1.
- Same Idempotency-Key: not_found then verified → second call hits the bank and returns verified.
- **Same key after cooldown, slip-system cache ON:** drive slip-system's `bankService` with `MemoryResultCache` enabled
  (or assert in slip-api that the outgoing `idempotency-key` metadata differs per request and that slip-system with the
  cache replays on equal keys). Request 1 → 404; request 2, same client key, after the cooldown → reaches the bank
  (mock call count = 2) → 200 verified.
- **Legacy row:** seed a not_found row with `idempotency_key='K'`, then a verify with key K whose bank returns verified
  → 200 verified (not 409). Afterwards the old row has key `''` and the new row has `K`. Use the real driver.
- **Zero balance:** balance 0 → the existing quota error, and the bank mock is never called (both VerifyBank and VerifyImage).
- Queue (Wave 1): a job whose bank result is 404 → completed not_found with `quota_used=false`, and the slip-system key = `<queueKey>:<job.RequestID>`. (The `:a1/:a2` test belongs to Wave 2.)
- `retryAfterSeconds`: 404 body has it at top level plus the header; the 200/409/422 golden JSON is unchanged; BBL/SCB
  values are driven by the real-slip fixtures.
- Cooldown: two not_found within 30s → one bank call; after the cooldown → second bank call.
- Batch 404 → `quotaUsed=false`.
- Real-driver repository test for any new query (sqlmock cannot catch bind types; see memory).

## Acceptance gates (source tests are NOT proof of these)

- **Staging (upslip-staging-ecs):** first re-read the runtime config: slip-system task def `RESULT_CACHE_MODE`,
  `RESULT_CACHE_TTL`, and the KBank sandbox vs live base URL. Then run a real not_found → retry with the same key → verified
  sequence. Whether the KBank sandbox can even produce a 404-then-200 slip is unknown; if it can't, record that as a
  blocker instead of claiming the flow is proven.
- **Prod after 24h — DB query, post-deploy rows only.** `:deployed_at` = the time the new slip-api task set reached
  steady state on `upslip-production-ecs` (from `aws ecs describe-services` deployments[].updatedAt, not the merge time).
  Pre-fix history is expected to be non-zero and is NOT the gate:
  ```sql
  SELECT count(*) AS charged_not_found
  FROM quota_history q
  JOIN verifications v ON v.id::text = q.reference_id
  WHERE q.reference_type = 'verification'
    AND q.quota_delta < 0
    AND v.status = 'not_found'
    AND q.created_at >= :deployed_at;          -- gate: 0
  -- sanity, same window: verified rows still charge
  SELECT count(*) FROM quota_history q JOIN verifications v ON v.id::text = q.reference_id
  WHERE q.reference_type='verification' AND v.status='verified' AND q.created_at >= :deployed_at;  -- gate: > 0
  ```
  Consumption is written as `quota_delta = -amount` (`branch_package.go:796`, verified). The query needs
  someone with prod DB access: the `vestearth` profile can read RDS CloudWatch metrics only. Also check
  `v.status='not_found'` rows exist in the window, otherwise a zero is vacuous (no traffic).

## Capacity impact (link TASK-VS-004)

After the migration, about 45% of BBL slips hit 404 on the first try, so each one needs at least 2 bank calls. That load
comes out of the shared KBank budget of 1200/min. Size it before the partner cuts over:
(partner slips/min) × (1 + BBL share × 0.45 × expected retries). If a synchronous retry storm from the partner is
likely, the Wave 2 delayed queue is the safer path, because we control the pacing.

## Partner-side advice — DEFERRED (operator 2026-09-26: finish our side first; not a Wave 1 deliverable)

- Delay the first attempt by bank: BBL ~2–3 min, SCB ~90s. Honour `retryAfterSeconds` once Wave 1 ships.
- Until Wave 1 item 2 ships, each retry needs a new Idempotency-Key **and** a new `rqUID`/`rqDt`, spaced at least ~2 min
  apart. Reusing a key means: slip-api replays the stored not_found; slip-system replays from its 5m cache, or returns
  ErrIdempotencyConflict if `rqDt` changed.
- After Wave 2 ships only: use the async queue endpoint (202 + webhook) and let Upslip handle the wait. Do not offer this before then: today a queued 404 completes as not_found with no re-check.
- Slip2Go/EasySlip are comparison only (operator, 2026-09-26). The partner will migrate fully to Upslip.

## Deploy / rollback

slip-api only; slip-system is unchanged. Merge → ECS deploy (staging `upslip-staging-ecs` first, then `upslip-production-ecs`).
Rollback = revert the commit. The cooldown index migration, if added, is additive and harmless to leave in place.
Partner announcement of the billing change is deferred (see Partner-side advice) until our side is done.

## Evidence to attach before closing

- RED → GREEN test output.
- Staging and prod: see **Acceptance gates** above. A staging run counts only after its runtime config has been re-read.
- Prod: output of the post-deploy DB query above (both counts plus the not_found row count in the window).

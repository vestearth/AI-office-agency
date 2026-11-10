# TASK-VS-068: Charge +1 quota for a KBank retry that returns 0000

Opened 2026-11-10 by the Claude conductor from Earth's chat decisions. Implementation goes to
another lane; the conductor does not implement this run.

Scope widened the same day (decision D2): a post-bank duplicate, which was sent to the bank, is
charged like any bank-checked slip. Only duplicates answered without asking the bank stay free.

## Why

- **KBank bills only `statusCode=0000`** (KBank, 2026-11-04; `runs/TASK-VS-059/task.md` ~:101).
  8404, 404/4040, other `rejected` codes and 8500 are free. KBank does not dedupe repeats.
- **Today's timeout path double-bills.** slip-system cuts the KBank call at 3.05 s
  (`TIMEOUT`/`RESPONSE_HEADER_TIMEOUT`, `MAX_RETRIES=0`, prod `slip-system-production:29`,
  `production-sha-171baeb`) and returns gRPC `Unavailable`. The ECS Service Connect proxy retries
  `Unavailable` on another task, the retry usually answers 0000, and the merchant gets 200 and pays
  1 quota. KBank still answers the first call later (its own timeout is 65 s) and bills it. We pay
  2, the merchant pays 1, and slip-api never learns a retry happened.
- **Size and owner (ev-001, prod logs, every page read):** ICT 2026-11-08 and 2026-11-09 had 1,186
  and 1,920 slip-system `kbank verify unavailable cause=bank_network` lines. All of them joined by
  `request_id` to a slip-api `/v1/slips/verify` line (0 unmatched) from one merchant, `84006774…`,
  one branch. Final status: 200 = 1,175 / 1,911, 408 = 8 / 4, 422 = 3 / 3, 409 = 0 / 2. That
  merchant is also 100 % of `/v1/slips/verify` traffic (460,160 lines on 11/08), so the timeout rate
  is about 0.26 %. The October invoice gap (30,808 over our verified count) is about 0.92 × the
  timeouts (KB `10 Projects/VerifySlip/KBank Monthly Reconciliation.md`).
- **The timeout cannot move.** The merchant gives up at about 8 s (157 408s at 7.88–8.01 s on
  2026-11-05; Earth, 2026-11-10: the merchant will not wait longer). TASK-VS-059 (12 s) was rolled back
  for merchant 408s and TASK-VS-061 (capped retry) was closed unshipped. A per-merchant timeout saves
  nothing because every timeout comes from this merchant.
- **Where 3.05 s came from (jaview `origin/main`, read 2026-11-10):** tuned by watcharapol-spl during
  the 2026-09-24 load test, 8 → 5 → 3.5 → 3.07 → 3.05 s (slip-system `ce38c4d`..`abec48c`), with no
  written reason. The load-test ceiling turned out to be the 1,200/min attempt budget (429), not the
  timeout (`60 Loadtest/reports/verify-step-20260924-ladder-100-1000.md`). The `Upslip 1M
  Architecture` note sets a p99 budget of under 3 s to the client.

## Decisions (Earth, chat, 2026-11-10)

1. **Keep the 3.05 s timeout.** No timeout change in this task.
2. **Charge one extra quota** (`QuotaCost` is 1 for every action today) when a verify's first KBank
   attempt timed out **after the request was written** and the slip's final KBank answer is `0000`.
   Receiver mismatch counts: it is a 0000 answer and KBank bills it.
3. **No extra charge** when the final answer is not 0000 (8404, other rejected, 404/4040, 8500), when
   the first attempt failed before the request was written (dial, TLS, reset, rate limiter,
   attempt budget, bulkhead; KBank never saw it), for `test=true`, for bypass, and for top-up
   (`Bypass: true`, no quota at all).
4. **Merchant notice before charging:** the merchant is told the rule before the slip-api production
   deploy that starts charging it (gate `merchant_notice`), including the post-bank duplicate charge
   (D2) and the meaning of "duplicates are not charged".

### Locked edge decisions (Earth, decision-grilling, 2026-11-10)

Facts found first: slip-landing prod promises "duplicate slips are not charged" in four places
(`manual/Results.vue`, `manual/Roles.vue`, `package/Compare.vue`, `package/MoneyFaq.vue`); the
merchant-visible history label is the free-text `quota_history.description`
(`QuotaHistory.HistoryItem`); `reference_type` has no CHECK constraint, `action` does
(migrations 021/025); `remaining_quota >= 0` is a CHECK.

- **D1 — no surcharge inside a charged 8404's 24 h free window.** A retried 0000 that the
  TASK-VS-063 rule makes free (base 0) stays free. About 5 a day (0.26 % retry rate × about 1,757
  "8404 then verified" slips a day), and the VS-063 merchant notice says a resend within 24 h is not
  charged again. Earth chose the recommended answer.
- **D2 — "a duplicate is not charged" means a duplicate our system answers without asking the bank**
  (Earth, 2026-11-10). Two kinds of 409 exist:
  - **Pre-bank duplicate** (`rejectDuplicateBeforeBank`: a verified row already exists, answered from
    the DB, no bank call): **free**, unchanged. 9,545 on 2026-11-08 ICT (409 under 100 ms).
  - **Post-bank duplicate** (passed the pre-bank check, the bank was called, then `rejectIfDuplicate`
    after the bank call, or the insert hit the unique index → `finishDuplicate`; caused by concurrent
    requests for one slip or a response `transRef` spelled differently from the request): it was
    sent to the bank, so it is **charged like any bank-checked slip: base 1, plus the retry surcharge
    when the call was retried (1 + 1 = 2)**. Today it is free. About 14 a day (409 at 100–999 ms on
    2026-11-08 ICT); retried ones: 0 on 2026-11-08 and 2 on 2026-11-09 (ev-001).
  - The base follows the normal rule for the bank's answer (0000 → 1, a TASK-VS-063 8404 → its
    per-slip rule, 404/4040 not_found → 0); in practice a post-bank duplicate is a 0000. D1 still
    applies to the surcharge.
  - This widens the task beyond timeouts (TASK-VS-063 decision 9 had left post-bank duplicates out)
    and changes every channel that uses `VerifyBank` (API, LINE, queue, batch). The FAQ's existing
    principle ("quota is used only for slips sent to the bank for checking") already covers it; the
    "duplicate" texts are clarified, not given an exception (slip-landing scope below).
  - Earth first chose "surcharge only" (0 + 1), then, after the two kinds were laid out, chose
    "charge the base too" (the recommended answer).
- **D3 — a separate `quota_history` row** for the surcharge (`quota_delta` -1), same `action` as the
  base charge (no migration), its own `reference_type` (e.g. `verification_bank_retry`,
  `reference_id` = the verification id) and its own `description` as the merchant-visible label
  (wording approved by Earth with the landing text, e.g. "ธนาคารตอบช้า ระบบส่งตรวจซ้ำ"). Not a single
  -2 row: the fast path needs quota for both, so a branch with 1 quota left would lose a verified
  result that KBank already billed. Earth chose the recommended answer.
- **D4 — not enough quota for the surcharge: skip it and log.** Save the result and the base charge
  as usual, write no surcharge row, and log one line (`request_id`, `branch_id`, reason) for counting.
  Never fail or roll back a verified result for the surcharge. The surcharge uses the normal
  consumption path, so a package with auto-renew on exhaustion renews as for any other charge.
  Earth chose the recommended answer.

## Scope

### slip-system (base `main`)

1. **Move the retry into the app** for the billing-ambiguous timeout only: `httpClient.Do` fails with
   `ctx.Err() == nil`, a `net.Error.Timeout()`, **after the request was written**
   (`httptrace.ClientTrace{WroteRequest}`; design already written in `runs/TASK-VS-059/task.md`
   "Scope — slip-system" item 2 and PR #19 `task/TASK-VS-059-kbank-timeout`). Retry once inside the
   same gRPC call, with its own 3.05 s attempt timeout.
   - Code: attempt loop `internal/repositories/kbank.go` ~:470–560 (`retriedAuth`, `retryableStatus`,
     `isRetryableNetwork`); error mapping `internal/handler/grpc/bank.go` (`mapBankError`,
     `bankUnavailableStatus`); causes `internal/models/bank.go` ~:199–207.
   - Do not raise `MAX_RETRIES`: it retries every retryable network error, including pre-write ones.
2. **Stop the proxy from retrying on top.** After the in-app retry, a second timeout must not reach
   the proxy as `Unavailable` (that would be a third billed call). Send it as `FailedPrecondition` +
   `ErrorInfo{Reason: "BANK_UNAVAILABLE"}` (VS-059 decision 1; slip-api already maps it to 502 +
   `Retry-After: 30`). Pre-write failures stay `Unavailable` so the proxy can still move them to
   another task. Confirm the Service Connect retry policy and count (not documented anywhere yet).
3. **Tell slip-api a billed retry happened** on the successful response. Pick one in the design:
   - response metadata (header or trailer, e.g. `x-bank-billed-attempts: 2`): no contract release;
   - a field on `VerifyBankSlipResponse` in slip-contracts: clone slip-contracts, keep the `replace`
     in go.mod, release the contract before both services.
   An old slip-api ignores either, so slip-system can ship first.
4. **Logs:** keep the TASK-VS-043 `kbank verify unavailable` line for the first attempt and add one
   line when the in-app retry succeeds (`request_id`, `elapsed_ms`, no slip fields), so acceptance can
   count retries without the proxy.

### slip-api (base `main`)

1. In `Verification.VerifyBank` (`internal/core/service/verification.go`), read the retry signal from
   `slipsystemadt` (`internal/adapters/slipsystemadt/adapter.go`) and charge the extra quota in the
   same transaction as the base rule (`saveBankRecord` → `SaveWithQuota` / `SaveBankNotFound`,
   `internal/repositories/verification.go`). The extra charge applies only per decisions 2–3 and D1–D4.
   For D2, the post-bank duplicate paths (`rejectIfDuplicate` after the bank call, and
   `ErrDuplicateSlip` from the save → `finishDuplicate` → `persistDuplicateAttempt`, which saves with
   `Save` and no quota today) charge the base row by the normal rule for the bank's answer, plus the
   surcharge row when the call was retried. The pre-bank path (`rejectDuplicateBeforeBank` →
   `duplicateResponse`) stays free. Keep the duplicate status and `duplicate_slip` reason on the row.
   Fix the comment "No quota: the slip was not sent to the bank again" so it applies to the pre-bank
   path only. `batchOutcomeFromVerify` already reports `quotaUsed=true` for duplicates; make it true
   only for post-bank ones.
2. Paths covered: HTTP verify (`internal/handler/http/bank.go` `verifyOne`), queue and batch
   (`internal/core/service/queue.go`), LINE (`internal/core/service/line_webhook.go`). Not charged:
   top-up (`internal/core/service/payment.go`, `Bypass: true`), `test=true`. The legacy gRPC
   `Verification.Verify` path has no retry signal today; leave it unless the design finds a caller.
3. If the extra row needs a new `quota_history` reference type, check for a DB constraint first
   (none found by a grep of migrations; confirm). A schema change needs its migration, idempotent,
   with deploy order and rollback (workspace guardrail 3).

### slip-landing

- State the rule where quota charges are explained (`app/components/manual/Results.vue`,
  `manual/Roles.vue`, `package/MoneyFaq.vue`, `package/Compare.vue`): a slip whose bank answer was
  slow and had to be resent costs one extra quota when the bank verified it.
- D2: clarify each "duplicates are not charged" text in those four files with the reason: the result
  comes from the earlier check without asking the bank again. Add a short note that sending the same
  slip several times at once can make the system ask the bank, and that check is charged like any
  other. Thai and English. Text approved by Earth.

### Out of scope

- Changing the 3.05 s timeout or waiting past the merchant's 8 s (VS-059 / VS-061).
- Save failures and receiver-lookup failures (no charge today, unchanged).
- Charging the merchant's own resends after a 502 (they are separate verifies and already charged
  normally when they return 0000).

## Coordination (gate `devops_coordination`)

jaview weekly notes for 2026-11-06 and 2026-11-13 list a devops item: "Improve verify retry/idempotency
handling with the affected merchant". Ask that lane what was done or agreed with the merchant before
the design is fixed, so the two do not collide. Ask watcharapol-spl why 3.05 s was chosen.

## Deploy order and rollback

1. slip-contracts (only if the field option is chosen).
2. slip-system main → staging → prod, each through a PR (VerifySlip promote rule). Behaviour change on
   its own: in-app retry replaces the proxy retry; merchants are not charged yet.
3. `merchant_notice` passes.
4. slip-api main → staging → prod through PRs: charging starts.
- Rollback: revert slip-api to stop charging without touching slip-system. Revert slip-system to bring
  back the proxy retry; an un-reverted slip-api then sees no signal and charges nothing extra.
- Check `slip_verify` status counts for the last few minutes before any prod merge (VS-059 lesson),
  and `origin/prod` ancestry: a teammate promotes slip-api directly.

## Traps

- **VS-059 #11 regression:** removing the proxy retry without an in-app retry raised 502s from
  0–3/h to 64–104/h on 2026-10-16. The in-app retry and the proxy change ship in one commit and deploy.
- **Merchant budget:** first attempt 3.05 s + retry 3.05 s + overhead must stay under about 8 s; the
  proxy path today has the same worst case (408 max 7,998 ms on 11/08). Do not add waits.
- **Same-task retry:** the proxy retried on another task; the in-app retry stays on the same task and
  may reuse a bad connection. Force a new connection for the retry or measure it on staging.
- **Bulkhead / attempt budget:** each retry takes a second slot and a second unit of the 1,200/min
  `BANK_ATTEMPT_LIMIT_PER_MINUTE` budget, as the proxy retry does today.
- **OAuth 401 retry** (`kbank.go` ~:536) is a separate re-login retry; keep it out of the billed count
  (KBank billing for 401 is unconfirmed).
- **Public repo:** this file syncs to a public repository. Keep the merchant id truncated, and keep
  KBank prices and customer names out of it.

## Acceptance

- **RED first:** a slip-system test with an httptest KBank that stalls the first request past the
  timeout after the body is written, then answers 0000: it fails today (proxy-only retry, no signal)
  and passes after. A pre-write failure (refused dial) is not retried in-app and stays `Unavailable`.
  A second timeout returns `BANK_UNAVAILABLE`, not `Unavailable`.
- slip-api table tests: retried + 0000 → base + 1 (two rows, surcharge row with its own
  `reference_type` and label); retried + receiver mismatch → base + 1; retried + 8404 → base rule
  only; retried + 0000 inside a charged 8404 window → 0 (D1); post-bank duplicate → 1 (D2);
  retried + post-bank duplicate → 2 (base row + surcharge row); pre-bank duplicate → 0, with no bank
  call (the stub sees none); retried + 0000 with quota for the base only →
  base saved, no surcharge row, one log line (D4); not retried → unchanged; `test=true`, bypass,
  top-up → no charge.
- **Staging:** one forced slow-then-0000 verify shows the retry line and two quota deductions.
- **Production (same 24 h ICT windows before and after, method of ev-001):**
  - first-attempt timeouts stay in the 1,200–1,900/day range;
  - extra charges ≈ retried calls that ended 0000;
  - post-bank duplicate charges ≈ 409s at 100 ms or more (about 14/day), and pre-bank 409s still
    charge 0;
  - merchant 408s stay near 4–8/day and 502s stay equal to the 8500 count (no new 502 source);
  - p95 of retried 200s stays near 3.7 s.
- **Month end:** the KBank invoice gap is covered by extra charges (reconciliation worksheet in KB).

## Evidence

- `ev-001`: `bash runs/TASK-VS-068/evidence/measure-timeouts.sh` (local only): slip-system 40 pages /
  3,109 events, slip-api 22 pages / 7,957 events, join 3,106 of 3,106 `bank_network` lines.

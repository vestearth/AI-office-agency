# TASK-VS-018: Treat KBank bank-unavailable codes as unavailable, not 422 rejected

## Context (incident 2026-10-12 23:30 ICT, still active at 00:15)

The partner reported that KTB was down and Upslip stopped working. Their
provider dashboard shows the Upslip share collapsing from 23:30, with failures
moving into "others (slip failed)". Every failing call gets:

```
POST /v1/slips/verify → 422 {"statusCode":422,"statusMessage":"rejected","data":{…all null…}}
```

Evidence (prod, `/ecs/slip-api-production`, merchant `84006774-abc7-4a1b-8af1-20decab2c30a`,
`event=slip_verify`, paginated census, UTC 10-min buckets):

| UTC         | 200   | 422   |
|-------------|-------|-------|
| 16:00–16:20 | ~2,400–2,550 | 5–15 |
| 16:30       | 863   | 649   |
| 17:00       | 876   | 1,581 |

- This was not caused by a deploy. slip-api td `:82` was deployed 2026-10-12
  15:10 ICT and served normal traffic for 8 hours afterwards. slip-system td
  `:20` has not changed since 2026-09-24.
- About 35% of 200 responses still succeed, which suggests that one sending
  bank is failing. The partner says it is KTB. **Not yet confirmed from our
  side:** the 422 body is all null, and slip-system logs nothing.

## Root cause in source (slip-api `main` 0fa820f, slip-system `main` d547d4a)

1. When KBank cannot reach the sending bank, it answers HTTP 200 with a
   non-`0000`/`404` `statusCode`. The code value has not been captured yet.
2. The partner route (`/v1/slips/verify`) calls slip-system `VerifyBankSlip`
   → `bankService.VerifyBank`, which returns the **raw** KBank response
   unchanged, with `statusCode` 8500. *Correction 10/13:* this path never
   reaches `kbank_normalize.go`, which serves only the `VerifySlip`/`Verify`
   path. That path has the same defect: every code other than
   `0000`/`0`/`404`/`4040` becomes `StatusRejected`. The redis result cache
   also stores the 8500 response and replays it for 5 minutes on the same key.
3. `slip-api/internal/models/verification.go` `bankVerificationStatus`
   (~L1019) and `PublicVerifyStatus` (~L226) map everything else to
   `422 "rejected"`.
4. `slip-api/internal/core/service/verification.go:149` and `:305` persist
   `rejected` through `SaveWithQuota`, so **every outage response costs the
   partner 1 credit**. Only `not_found` uses the free `vr.Save` path
   (TASK-VS-005).
5. Batch/queue `batchOutcomeFromVerify` (`queue.go:~443-450`) has the same
   default: `rejected` with `quotaUsed: true`.

This contradicts ADR-VS-0001 / `slip-doc/STRUCTURE.md`: a bank outage must
come out as INCONCLUSIVE, never NOT_VERIFIED.

The error path already behaves correctly. When slip-system returns
`models.ErrUnavailable`, the gRPC handler maps it to `codes.Unavailable`
(`internal/handler/grpc/bank.go`). slip-api `mapVerifyError` then answers
`502` before any save, so no record is written and no quota is used. The
batch path marks the item `failed` with `quotaUsed: false`. The fix should
**route the unavailable codes onto this existing path** instead of adding a
new status.

## Step 0: capture the real KBank codes (blocking, needs prod DB read access)

The `vestearth` profile cannot read the prod DB. Someone with RDS access
should run:

```sql
SELECT sending_bank, status_code, status_message, count(*)
FROM verifications
WHERE status = 'rejected' AND created_at >= '2026-10-12 16:30:00+00'
GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 30;
```

**Result (operator ran it 2026-10-13 ~00:30 ICT):**

| sending_bank | status_code | status_message | count |
|---|---|---|---|
| 006 (KTB) | 8500 | Internal system error - Destination Bank | 5,227 |
| 030 (GSB) | 8500 | same | 276 |
| 011 (TTB) | 8500 | same | 98 |
| 025 (BAY) | 8500 | same | 66 |
| 034 (BAAC) | 8500 | same | 45 |
| 088 | 8500 | same | 9 |
| 073 / 024 / 014 | 8500 | same | 2 / 1 / 1 |
| 01 | 6501 | REJECTED | 2 |

- This confirms KTB (`006`) is the outage source: 5,227 of 5,727 rows.
- **Allowlist = `8500`** ("Internal system error - Destination Bank"). The
  message itself says the destination bank failed, not the slip.
- `6501 REJECTED` is a genuine rejection and must stay `rejected`.
- Still to do: run the same query for the 7 days before the incident to get
  the normal `8500` rate per bank. It should be small, and it sizes the
  refund decision. Non-KTB `8500` rows may be ordinary per-bank blips.

Columns come from `migrations/004_verifications.sql` (`status_code`,
`status_message`), written by `NewVerificationRecord`. Run the same query for
the 7 days before the incident to see which codes are genuine slip
rejections. **Only codes that mean "bank or system unavailable" belong on
the allowlist.** Any code that could mean a forged or invalid slip must stay
`rejected`. Record the query output under `evidence/` (in the gitignored
allowlist) and in `implementation_verification`.

## Scope

- **slip-system** `kbank_normalize.go`: an explicit allowlist of KBank
  bank-unavailable statusCodes returns `fmt.Errorf("%w: kbank %s: %s",
  models.ErrUnavailable, code, msg)` instead of `StatusRejected`. Unknown
  codes keep today's `rejected` behaviour (fail closed on fraud).
- **slip-system**: log one structured WARN line for each non-success
  normalization, with `status_code`, `status_message` and `sending_bank`, and
  no PII or images. Tonight there was nothing to read.
- **slip-system**: confirm that the redis result cache
  (`RESULT_CACHE_MODE=redis`, `doCachedWithReplay` in
  `internal/core/services/bank.go`) does **not** cache the unavailable error,
  so a retry with the same key reaches KBank again once the bank recovers.
  Cover all three idempotency layers from TASK-VS-005: slip-api replay,
  slip-system cache, and the legacy unique index.
- **slip-api**: no change is expected, provided Unavailable already gives a
  non-422 response with no record and no quota. Pin this with a test. Agree
  with the partner on the response code: keep the existing `502` from
  `mapVerifyError`, or move to `503` with a stable message such as
  `bank_unavailable`. **This is a public contract decision; ask the operator
  before changing it.**
- Partner docs (`slip-front-end/app/features/developers/`): document the new
  "bank unavailable, retry or fall back" response. Optional, same PR series.

## Out of scope (separate decisions)

- Refunding credits charged for `rejected` rows during the outage window. This
  is a prod DB write and needs operator approval plus a `production_backfill`
  gate on its own run. **Operator 2026-10-13: on hold until the partner raises
  it. Do not promise a refund in partner communication.**
- An alarm on the 422 share, for example >10% in 5 min, through
  `upslip-prod-alarms-to-lark`. Suggested follow-up: the partner noticed this
  incident before we did.

## Acceptance criteria

- RED first: a `kbank_normalize` test with an allowlisted unavailable code
  expects `errors.Is(err, models.ErrUnavailable)`, and fails on current
  `main`. A test with an unknown non-success code still expects
  `StatusRejected`.
- A slip-api test shows that a gRPC `Unavailable` from slip-system leaves no
  verification row, makes no `SaveWithQuota` call, and returns no 422. Batch
  items become `failed` with `quotaUsed=false`.
- A cache test shows that an unavailable result is not replayed: the second
  call with the same key reaches the verifier again.
- Staging acceptance: inject the unavailable code through the mock bank
  (`bank_mock.go`) or a test hook, and observe a non-422 response, no credit
  change, and the new WARN log line.
- Production acceptance: after deploy, a slip from a bank in a real
  unavailable condition, or the post-deploy census, shows no `rejected` rows
  carrying the allowlisted codes.

## Deploy order and rollback

1. Deploy slip-system first. slip-api already handles `codes.Unavailable`, so
   the order is safe.
2. Deploy slip-api only if the response-code contract changes.
3. Rollback: revert the slip-system pin. The behaviour returns to today's
   422 `rejected`. No schema change and no migration.

## Traps

- No PR CI: merging `main` is the deploy, and the prod Actions waiter can fail
  while ECS completes. Check the ECS service events.
- Do not widen the allowlist by guessing. A code that turns a forged slip into
  "unavailable" makes the partner's fallback re-verify it elsewhere, which is
  still safe. A code that turns an outage into `rejected` is today's bug.
  When in doubt, leave the code out and log it.

## Implementation (2026-10-13, Claude conductor lane, operator asked to implement here)

- SparqLab/slip-system PR #5 (`task/TASK-VS-018-kbank-8500-unavailable`,
  `bb48f72`): `kbankUnavailable` with allowlist `{"8500"}` returns
  `ErrUnavailable` plus a `log.Printf` line (statusCode, statusMessage,
  sendingBank). It is applied in `VerifyBank` and `normalizeKBankResponse`.
  The error is not cached, and gRPC returns `Unavailable`.
- SparqLab/slip-api PR #60 (`task/TASK-VS-018-unavailable-no-charge`,
  `a5d3e74`): tests only. They pin no row, no quota, retry reaching
  slip-system, batch `failed` without quota, and HTTP 502.
- Public response decision: keep the existing envelope
  `502 {"status":502,"message":"bank verifier unavailable"}`. No 503 or
  contract change was made; the operator has not asked for one.
- Evidence: ev-001 (slip-system vet + full suite on `bb48f72`, pass);
  ev-002 (RED: the new tests copied onto `origin/main` fail with
  `err = <nil>`, `exit=1` in the log); ev-003 (slip-api vet + full suite on
  `a5d3e74`, pass).
- Deploy: slip-system only (main → staging → prod). slip-api #60 can merge at
  any time, since it changes tests only. Staging acceptance: the mock bank has
  no 8500 fixture, so use a unit-level proof plus a prod post-deploy census
  (expect zero new `rejected` rows with `status_code = '8500'` and the new log
  line present), or add a mock trigger if the operator wants a live staging
  probe.

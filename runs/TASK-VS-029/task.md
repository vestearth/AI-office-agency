# TASK-VS-029: Stop logging slip personal data in duplicate-slip 409 error_message

- Type: security / privacy bugfix (slip-api)
- Created: 2026-10-16 by the Claude conductor lane at operator request. Claude opens
  this run only; implementation goes to another lane.
- Gates: preset `production`.
- Found during the TASK-VS-028 investigation (bank-unavailable outage of 2026-10-15).

## Problem

On a 409 duplicate-slip response, slip-api writes the full response body into the
`error_message` of its access log in CloudWatch. That body includes payer and payee
names, masked account numbers and `trans_ref`.

Source (origin/main):
- `internal/handler/middleware/audit.go` — for every response with status >= 400 the
  middleware sets `errMsg = errorMessageFromBody(recorder.body, status)` and logs it as
  `error_message` (also on the panic path, line ~105).
- The same `errMsg` goes to `persistRequestLogs(...)`, which stores it in the request-log
  table (`internal/repositories/logs.go`, column `error_message`). So the data is also
  persisted in the database, not only in CloudWatch.

## Scope

1. `error_message` must never carry slip or person data: log a fixed, code-level message
   (or the error `code`/`message` field only) for 409 duplicate-slip and any other response
   whose body echoes verification data. Prefer an allowlist of fields over stripping.
2. Apply the same to what `persistRequestLogs` stores.
3. Decide (operator) how to treat what is already stored: CloudWatch retention / deletion
   of the affected log streams and the request-log rows. Do not delete anything without
   that decision; record the decision in this run.
4. Check sibling paths for the same pattern (other handlers echoing slip data into errors).

## Acceptance

- A regression test: a 409 duplicate-slip response produces a log line and a stored
  request-log row with no names, account numbers or trans_ref (seen failing first).
- Staging evidence: one duplicate verify, its CloudWatch line and request-log row checked.
- Response body to the client unchanged (contract).
- The handling of existing data is decided and recorded.

## Evidence handling

Do not copy raw log lines into this run or any synced artifact: they contain the very
data this task removes. Reference counts, timestamps and request ids only.

## Review (Claude conductor, 2026-10-16) — verified, scope adjustments proposed

Checked against slip-api `origin/prod` 78e47ab and production CloudWatch (counts only;
no log values copied).

**Confirmed**
- Root defect is the fallback in `errorMessageFromBody`
  (`internal/handler/middleware/audit.go` ~247): it keeps only a top-level `message`
  field, otherwise stores the whole body (truncated to `maxErrorMessageStore` = 1024
  runes). Verify outcome bodies (`models.WrapVerifyOutcome`,
  `internal/models/verification.go` ~274) have no `message` key — top-level keys are
  `statusCode`, `statusMessage`, `data`, `outcome_reason` — so the slip `data` object
  goes into `error_message`.
- Still happening on production: last hour (to ~2026-10-16 04:00Z) 341 / 341 verify 409
  lines carried the slip `data` object in `error_message`.
- Persisted too: `shouldPersistRequestLog` covers `/v1/slips/verify`,
  `/v1/slips/verify/qr-code`, `/v1/slips/verify/batches`, so the same text reaches the
  request-log table via `persistRequestLogs` (outbound row `ErrorMessage`).
- The panic path (~93-107) uses the same function.

**Proposed adjustments**
1. Priority: treat as an active leak — it is not limited to the 10-15 outage; every
   duplicate (and receiver-mismatch) verify writes it now. Ship before VS-028 item 1.
2. Scope item 4 is concrete, not hypothetical: verify 422 responses also carry `data`
   (14 of 14 in the same hour; receiver mismatch uses the same `WrapVerifyOutcome`).
   The fix must cover every 4xx/5xx body, not only 409.
3. Fix at the root: `errorMessageFromBody` must never fall back to the raw body. Keep
   an allowlist — `message`, else `outcome_reason`, else `statusMessage` (bank text, no
   person data), else `http.StatusText(status)`. Regression test with a duplicate and a
   receiver-mismatch body asserting no `data` content in the log attr or stored row.
4. Existing data decision (operator), with facts: `/ecs/slip-api-production` retention
   is **never expire** (~1.1 GB stored, 2026-10-16). Options: set a retention period
   (affects all slip-api prod logs), or targeted stream deletion; plus the request-log
   rows with non-empty `error_message` for verify paths. Nothing deleted yet.
5. Evidence handling stays as written: counts, timestamps and request ids only.

## Implementation (Claude conductor, 2026-10-16)

Operator asked Claude to implement this task directly (chat 2026-10-16), overriding the
"another lane" note above. slip-api PR #70, commit cab77a1 on
`task/TASK-VS-029-error-message-allowlist` (base origin/main f30e85f).

- `errorMessageFromBody` keeps `message`, else `outcome_reason`, else
  `http.StatusText(status)`; never the raw body. Same value feeds the access log, the
  panic path and `persistRequestLogs`. Client response unchanged.
- Tests (`internal/handler/middleware/audit_test.go`, synthetic data only): through the
  real `AuditLog` middleware for 409 duplicate / 422 receiver mismatch / 500 without a
  reason, asserting no names, trans_ref or `"data"` in the JSON log or stored row.
  RED ev-001, GREEN ev-002. `go test ./...` ev-003 ran without the repository DSN
  (Docker paused; DB tests skipped, unaffected by this change); race ev-004, vet ev-005,
  readonly build ev-006.
- Siblings (scope 4), unchanged: `internal/core/service/verification.go` ~633 logs
  `trans_ref` only when persisting a duplicate attempt fails (no names); LINE/Lark
  adapters wrap third-party API error bodies into errors (not slip data).
- Existing data (scope 3) still awaits the operator decision; nothing deleted.

## Review round 1 (independent reviewer, APPROVE WITH NITS) — 2026-10-16

- Fix verified on both outputs and both middleware paths; client responses unchanged;
  reviewer reproduced RED on main.
- Test corrected in 4c7fb82: receiver mismatch answers 200 in production, so the 422 case
  now uses real verify outcomes (409 duplicate, 422 rejected, 404 not_found, built as
  `writeVerifyResult` does) plus `/v1/payments/slips` 422. RED ev-007 / GREEN ev-008;
  suite, race, vet, build ev-009.
- **Second leak source, now fixed by the same change:** `/v1/payments/slips` 422
  (`writeRejectedPayment`, `PaymentTransactionResponse`: sender/receiver name and
  account, trans_ref, slip image URL) went into CloudWatch `error_message` (not persisted:
  path not in `shouldPersistRequestLog`). Include these lines in the existing-data scope.
- **Existing data is still being served:** `GET /v1/audit-logs`
  (`internal/repositories/logs.go` ~127, router ~466) returns `error_message` from stored
  rows to merchant users and scoped staff, so rows written before deploy keep exposing
  slip JSON. Raises the priority of scope item 3 (operator decision).
- Deviation from the reviewed plan: `statusMessage` is not allowlisted (fixed word 1:1
  with the status code; no consumer matches `error_message` text).
- Follow-ups (low): `internal/core/service/verification.go` ~633 logs trans_ref on a
  persist failure; `internal/core/service/auth.go` ~445 logs an email when saving a
  login log fails; LINE/Lark adapters wrap third-party error bodies;
  `internal/handler/grpc/verification.go` ~98 returns internal error text to gRPC clients.
- Unverified: CloudWatch metric/subscription filters on `/ecs/slip-api-production`
  (AccessDenied for vestearth).

## Production verification (2026-10-16)

- Deployed: staging 41da2c9 → prod 96082d4, `slip-api-production:93` 3/3, steady
  04:50:45Z (Deploy PRODUCTION run 38851779973; authz-002, operator waived the staging
  duplicate check because staging only accepts approved test slips).
- CloudWatch 04:50:46–05:01:49Z (ev-012): 83 `>=400` lines with `error_message`, 0 with
  JSON or `data`; verify 409 ×69 = `duplicate_slip`; 0 ERROR.
- request_logs (read-only, operator DBeaver, 12:50 ICT;
  `check-request-logs-prod-results-2026-10-16.md`): after the cutoff 401 outbound verify
  rows `>=400`, 0 contain `"data"`.

## Existing data — still to decide (acceptance item 4 open)

- request_logs, last 3 days only: **30,397** outbound verify rows contain slip `data`
  (409: 26,724; 422: 3,673). Older rows were not counted. These rows are still returned
  by `GET /v1/audit-logs` (`error_message`) to merchant users and scoped staff.
- CloudWatch `/ecs/slip-api-production`: retention never-expire (~1.1 GB); verify 409/422
  and `/v1/payments/slips` 422 lines before 04:50:46Z carry slip data.
- Options for the operator: (a) blank/replace `error_message` on affected request_logs
  rows (one UPDATE, reversible only from backup); (b) stop serving `error_message` in
  `/v1/audit-logs` for old rows; (c) set a CloudWatch retention period (applies to all
  slip-api prod logs); (d) accept and document. Nothing deleted or changed yet.

## Existing data — operator decision (2026-10-16): (a) + (b); CloudWatch deferred

Operator chose: (a) clean the stored rows (operator runs the SQL) and (b) stop
`GET /v1/audit-logs` serving raw stored `error_message`. CloudWatch retention / deletion:
decide later.

- (b) slip-api PR #71, commit 486a302 (branch `task/TASK-VS-029-audit-logs-sanitize`):
  allowlist moved to `models.ErrorReason` (shared with the middleware);
  `models.SafeStoredErrorMessage` serves stored JSON as its reason, else status text, plain
  text unchanged; applied in `RequestLogRepository.ListByUser` (only reader). Repository
  integration test RED ev-014 / GREEN ev-015; full suite with repository + migration DSNs
  ev-016; race, vet, readonly build ev-017.
- (a) `cleanup-request-logs-error-message.sql`: preview (read-only) → batched UPDATE of
  outbound rows whose `error_message` starts with `{` to outcome_reason or status text
  (20,000 per run, `lock_timeout` 5s, repeat until 0) → verify (both counts 0). Tested on
  synthetic local rows (run 1 updated, run 2 = 0; inbound/plain rows untouched). Not yet run
  on prod. RDS backups keep old values until they age out.
- Independent review of #71 and the SQL is running.

## Review of #71 and the cleanup SQL (2026-10-16)

- PR #71: APPROVE WITH NITS; table test for `SafeStoredErrorMessage` added in d10c15e.
  Full suite ev-018: middleware/models green; `internal/repositories` failed only on
  `TestScopedVerificationCountIsAnsweredByIndex` (from VS-027 / #69), which is flaky on a
  shared DB (2 of 4 local runs) and untouched by #71 — tracked as a separate follow-up.
- Cleanup SQL revised per review: step 0 schema check first; `{`/`[` match; each batch is
  an explicit `BEGIN … SET LOCAL lock_timeout/statement_timeout … COMMIT` (DBeaver must be on
  Auto-commit, not Smart commit); step 4 `VACUUM (ANALYZE) request_logs`; irreversibility
  notes (dead tuples until vacuum, WAL, replicas, RDS backups, CloudWatch). Re-tested on
  synthetic rows: run 1 updated, run 2 = 0, verify 0|0, plain-text 409 untouched.
- **Blocking check before cleanup:** migration 003 originally created
  `request_logs.body JSONB` holding full request/response bodies (8b4c5d8); b845fbc
  (2026-08-20) edited the applied migration instead of dropping it, and no migration ever
  drops it. If prod ran 003 before 2026-08-20, `request_logs.body` (and possibly legacy
  JSON columns on `verifications`) may still hold full slip data. Step 0 answers this; if
  present, the scope widens (operator decision + migration).
- Step 0 on prod (2026-10-16 13:06 ICT, read-only, `cleanup-step0-prod-results-2026-10-16.md`):
  **0 rows** — no json/jsonb column (no legacy `request_logs.body`) on `request_logs` or
  `verifications`. Cleanup scope stays `error_message` only; steps 1–4 not yet run.

## (b) deployed — slip-api PR #71 (2026-10-16)

- Merged bffe053 at reviewed head d10c15e; main → staging 700d557 (td :135 steady
  13:22:41 ICT, 0 new ERROR — ev-020); staging → prod 5aa3027 (Deploy PRODUCTION run
  38860936652; `slip-api-production:94` 3/3, steady 06:34:34Z, 0 ERROR — ev-021).
  Authorizations authz-003 (staging) / authz-004 (prod).
- `GET /v1/audit-logs`: no request since deploy at 06:35Z; response content needs an
  authenticated merchant/staff view (Claude has no token). Check one row that is still JSON
  in the table **before** running the cleanup SQL, otherwise the cleanup hides whether #71
  works.

## (a) cleanup executed on prod (2026-10-16, operator) — `cleanup-execution-prod-results-2026-10-16.md`

- Step 1: 135,500 outbound rows with JSON `error_message`, all containing slip `data`
  (409: 100,308; 422: 35,192), oldest 2026-09-25 10:58 ICT, newest 2026-10-16 11:43 ICT
  (before the 96082d4 fix went live).
- Step 2: 8 batches, 135,500 rows updated (matches preview), last batch 0; Auto-commit.
- Step 3: `json_rows_left = 0`, `data_rows_left = 0`.
- Step 4: `VACUUM (ANALYZE) request_logs` done, `last_vacuum` 14:02:38 ICT. Connection set
  back to read-only.
- Old-row API check for #71 skipped by the operator (merchant API queries for 2026-09-25 to
  10-15 returned 0 items for that session, so they proved nothing). #71 is covered by its
  integration test; after the cleanup no stored JSON remains for it to sanitise.

## Close-out

Done: write path fixed (#70, prod 96082d4), read path fixed (#71, prod 5aa3027), stored
rows cleaned (135,500 → 0). Still open, recorded as deferred operator decisions/follow-ups:
- CloudWatch `/ecs/slip-api-production` (retention never-expire) still holds pre-fix verify
  409/422 and `/v1/payments/slips` 422 lines with slip data.
- RDS backups / snapshots / WAL keep old values until they age out.
- Minor sibling logs: `verification.go` trans_ref on persist failure; `auth.go` email on
  login-log failure; LINE/Lark third-party error bodies.

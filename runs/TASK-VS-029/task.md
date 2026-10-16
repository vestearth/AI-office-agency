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

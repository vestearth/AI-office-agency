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

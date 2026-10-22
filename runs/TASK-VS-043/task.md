# TASK-VS-043: slip-system: log cause class of silent bank-unavailable errors with request_id

Follow-up to SPAR-33 (item D12). Repo: `slip-system` only. Branch from latest `main`, PR into `main` (VerifySlip branch flow). No proto, config, or production change in this task.

## Problem (verified 2026-10-21, read-only)

- slip-api returned 502 `bank verifier unavailable` to `POST /v1/slips/verify` 16 times between 2026-10-20 00:42 ICT and 2026-10-21 00:49 ICT, all from one merchant/branch. For 15 of them, a slip-system `kbank destination bank unavailable: statusCode=8500` line appears in the same second: 10 per the SPAR-33 investigation, plus 5 at 00:42–00:45 ICT (bank `011`) re-checked on 2026-10-21. This is a timestamp match, not proof per request.
- The 16th, request `e3267fd8d3f2d9f8ff9c16df037164f8` at 2026-10-20 05:08:15Z (170 ms), has **no** slip-system log line at all from 05:07:45Z to 05:08:45Z (CloudWatch `/ecs/slip-system-production`, full pull, no nextToken). Its cause cannot be recovered.
- The cause is that slip-system logs only the 8500 branch (`internal/core/services/kbank_normalize.go`). Every other path that wraps `models.ErrUnavailable` is silent. On `origin/main` `6bf7b34` these include the OAuth network/read/decode/empty-token errors, circuit open, rqUID mismatch, attempt budget, KBank network/read errors, KBank HTTP 5xx, decode error, invalid amount (`internal/repositories/kbank.go`, 14 sites), and the redis concurrent-verification wait (`internal/repositories/redis.go`). `mapError` / `mapBankError` (`internal/handler/grpc/bank.go:95`, `:116`) map all of them to the same message.
- Since SPAR-33 #14 (prod via slip-system #16, 2026-10-21) the caller's id is available as `VerifyHTTPRequest.RequestID` (from the `x-request-id` metadata), and slip-api prod sends that metadata.

## Scope

- When a verify call ends in `ErrUnavailable` other than `ErrDestinationBankUnavailable`, log one line with a **fixed cause class** (for example `circuit_open`, `attempt_budget`, `bank_network`, `bank_http_5xx`, `bank_decode`, `oauth`, `rquid_mismatch`, `concurrent_wait`) and the sanitized `request_id` (reuse `loggedRequestID`, `%q`).
- Do not log the raw wrapped error text if it can carry a URL, token, response body, transRef, or other slip data. Prefer the class plus the HTTP status code where one applies.
- Keep the gRPC status codes, messages, and the 8500 `FailedPrecondition` + `BANK_UNAVAILABLE` contract unchanged (TASK-VS-028). This change only adds logging.

## Acceptance

- A RED test per class group, seen failing before the fix: the log is missing or has no class/request_id. It passes after the fix.
- The test asserts that the log line contains no transRef or sendingBank account data, and that a hostile `request_id` (space, `=`, newline, 129 chars) is quoted and capped.
- `GOWORK=off go test -count=1 ./...` and `GOWORK=off go build -mod=readonly ./...` pass. `slip-contracts` stays a sibling checkout and the `replace` stays.
- PR into `main` with the target branch verified via `gh pr view`. Promotion to staging/prod needs Earth's approval.

## Not in scope

- Retry, circuit breaker, or rate-limit behaviour changes.
- The ALB-generated 5xx (needs ALB access logs; SPAR-33 item A).

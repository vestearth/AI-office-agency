# TASK-VS-044: slip-api: find the cancellation source behind persistDuplicateAttempt context canceled

Follow-up to SPAR-33 (item D13). Repo: `slip-api` only. Branch from latest `main`, PR into `main`. Instrument first; do not change audit-write behaviour until the source is known. No migration, proto, or production change in this task.

## Problem (SPAR-33 investigation, 2026-10-21)

- On 2026-10-21 at 08:58:06.722 ICT, prod logged `persist duplicate slip attempt failed` with `generate verification id: context canceled`. The same branch's access log 3 ms later shows `POST /v1/slips/verify` → HTTP 408, `context canceled`, 393 ms. The two lines match on timing only: that error line had no `request_id`.
- `persistDuplicateAttempt` (`internal/core/service/verification.go:618` on `origin/main` `113b021`) calls `Save` (no quota). `insertVerification` failed at `SELECT gen_random_uuid()` (`internal/repositories/verification.go:55`/`:243`) before the `INSERT`. As a result, that duplicate attempt has no history row. No credit is consumed on this path, and there is no evidence that a duplicate slip was let through.
- Two cancellation sources are possible and the current logs cannot tell them apart: (a) the client or ALB closed the request (handler ctx), or (b) an internal context such as the idempotency-lock context. Since SPAR-33 slip-api #81 (on prod in `slip-api-production:100`), this error line carries `request_id`.

## Scope

- Make the failure log name the cancellation source. Log `context.Cause(ctx)` where a cause is set, and set causes (`context.WithCancelCause` / `WithTimeoutCause`) on the internal contexts that can cancel this path. Also log whether the request ctx was already done (`ctx.Err()`) and the elapsed time since the request started.
- Keep `request_id` and `branch_id`. Never log the transRef, slip fields, or sender/receiver data.
- **Only after** the instrumented cause has been observed (or reproduced in a test) propose whether to use a bounded audit-write context (`context.WithoutCancel` + a short timeout) for the duplicate-history `Save`. That proposal is a separate decision for Earth.

## Acceptance

- A RED test, seen failing before the change, cancels the request ctx and then an internal ctx, and asserts the log distinguishes the two.
- `GOWORK=off go test -count=1 ./...` and `GOWORK=off go build -mod=readonly ./...` pass. `slip-contracts` stays a sibling checkout and the `replace` stays.
- PR into `main` with the target verified via `gh pr view`. Promotion needs Earth's approval.

## Traps

- The duplicate path must not start consuming quota (`persistDuplicateAttempt` uses `Save`, not `SaveWithQuota`).
- `models.ErrDuplicateSlip` from `Save` is still swallowed (returns nil).
- Retry/idempotency changes must cover both the slip-api PG replay and the legacy unique index (see `runs/TASK-VS-005/task.md` and `runs/TASK-VS-041`). This task should not touch either.

## 2026-10-31 evidence and decision

- Since slip-api #81 put `request_id` on this line, prod logged it 4 times from 2026-10-21 08:00Z to 2026-10-31 00:00Z, all on branch `816d9bc9`. Each joins by `request_id` to its access-log line: `POST /v1/slips/verify` → 408 `context canceled` after 161–359 ms (ev-001).
- On slip-api `origin/main` `eededfb` the verify path creates no `WithCancel` context. The repository contexts are `WithTimeout`, which end in `DeadlineExceeded`, not `Canceled`, and their timeouts are far above 359 ms. So the request context was canceled: the client (or the ALB on its behalf) closed the request. This is inferred from logs and code, not instrumented.
- **Earth chose option B (2026-10-31):** skip the instrumentation step. Write the duplicate-attempt history row even after the client closes the request: `context.WithoutCancel` plus a short timeout, for the duplicate `Save` only. It stays `Save` (no quota), and `ErrDuplicateSlip` from `Save` is still swallowed.

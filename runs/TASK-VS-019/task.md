# TASK-VS-019: Log request sendingBank when KBank 8500 is mapped to unavailable

## Context

This is a follow-up to TASK-VS-018, which shipped to prod as slip-system td
`:21` on 2026-10-13. The new prod line `kbank destination bank unavailable:
statusCode=8500 … sendingBank=` always printed an empty `sendingBank`, because
KBank 8500 responses carry no `data`. The line could not tell KTB apart from
other banks, which was the point of adding it.

## Scope

- slip-system `kbankUnavailable(response, sendingBank)` logs the request's
  sending bank (`payload.Data.SendingBank`) on both `VerifyBank` and
  `Verify` → `normalizeKBankResponse`.
- Logging only. Status mapping, caching and responses are unchanged.

## Acceptance criteria

- RED test `TestDestinationBankUnavailableLogsRequestSendingBank` fails on
  `main`, with `sendingBank=` empty on both paths. It passes after the change.
- Production: new 8500 log lines show a non-empty `sendingBank` (for
  example `006`).

## Implementation

- SparqLab/slip-system PR #8 (`6926292`), merged to `main`.
- Evidence: ev-001 (vet + full suite pass), ev-002 (RED on `origin/main`).

## Deploy and rollback

- Order: slip-system `main` → `staging` → `prod`. Logging only, so slip-api
  needs no change.
- Rollback: revert the commit. No schema change.

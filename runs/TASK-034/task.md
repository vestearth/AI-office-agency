# TASK-034: Align 1UP callback error/status contract with seamless API tests

Epic: Seamless API Testing v1

Parent: none

Type: bugfix

Priority: critical

Created At: 2026-04-28

## Scope

### Target Services

- `Games-Labs-Provider` -- owns the 1UP callback handlers for `/player/info/get`, `/player/balance/get`, `/bets/result`, and `/bets/refund`; current responses mismatch expected error/status contract.

### Affected Files

- `Games-Labs-Provider/internal/handlers/providerhdl/oneup_callback.go` (modify) -- normalize error mapping and validation flow per endpoint so invalid signature/session/player/game/input return the expected codes and HTTP statuses.
- `Games-Labs-Provider/internal/handlers/providerhdl/oneup_runtime.go` (modify if needed) -- refine helper-level error mapping so user/game/session failures can be distinguished consistently from unauthorized and internal failures.
- `Games-Labs-Provider/internal/handlers/providerhdl/oneup_callback_test.go` (create/modify) -- add endpoint-level coverage for the failing CSV scenarios and lock contract behavior.
- `Games-Labs-Provider/internal/adapters/1up/signature_test.go` (modify if needed) -- keep signature validation tests aligned with callback expectations.
- `ai-dev-office/runs/TASK-034/task.md` (create) -- PM blueprint for callback contract fix.
- `ai-dev-office/runs/TASK-034/status.yaml` (create) -- initialized workflow state.
- `ai-dev-office/runs/TASK-034/pm-output.yaml` (create) -- structured PM handoff.

## Description

The current 1UP seamless callback implementation responds with incorrect error
codes and HTTP statuses for several invalid-input and invalid-entity paths. The
latest API testing CSV reports 13 failures, mainly because invalid
session/player/game paths return `401` or `200` where `404` is expected, and
negative bet/win values return success instead of validation errors.

This task aligns callback behavior to the approved test contract for all four
endpoints in scope without changing signing logic or widening service scope.

## Acceptance Criteria

- `POST /player/info/get` returns:
  - `401 ERR_UNAUTHORIZED` only for invalid signature.
  - `404` for invalid `sessionID`, `playerID`, or `gameID` paths covered by the seamless test contract.
- `POST /player/balance/get` follows the same contract split as `player/info/get`.
- `POST /bets/result` returns:
  - `400 ERR_INPUT_INVALID` when `bet < 0` or `win < 0`.
  - `404` for invalid `sessionID`, `playerID`, or `gameID` paths covered by the seamless test contract.
  - Existing passing behavior for duplicate bet ID and insufficient balance remains unchanged.
- `POST /bets/refund` returns `404` for invalid `playerID` or `gameID` scenarios in the test contract (not `200` success).
- Automated tests (table-driven preferred) cover all previously failing scenarios from the CSV and pass locally.
- Re-running the seamless API test dataset yields 32/32 pass (or documented residual gap with concrete blocker).

## Plan

### Approach

Use handler-first fixes in `oneup_callback.go` so each endpoint enforces a clear
validation order: signature -> required fields -> entity/session checks ->
business logic. Keep a single mapping path for domain errors to avoid status
drift across endpoints. Add regression tests matching the exact failing scenarios
from the CSV to prevent future contract regressions.

### Subtasks

1. `dev` -- Implement a normalized callback error mapping strategy for invalid signature, invalid session, missing/invalid entities, and invalid numeric input.
2. `dev` -- Patch each endpoint flow (`player info`, `player balance`, `bet result`, `bet refund`) to return contract-expected status/code combinations.
3. `dev` -- Add focused endpoint tests for all 13 previously failing scenarios and verify no regression in currently passing paths.
4. `dev` -- Run targeted tests and provide a short pass/fail matrix against the CSV expectations.

### Risks And Mitigations

- **Risk:** Existing clients depend on current (incorrect) status behavior.
  **Mitigation:** keep changes scoped to documented seamless contract paths and document behavior change in release note.
- **Risk:** Error-source ambiguity from wallet/redis helpers can still leak wrong status.
  **Mitigation:** centralize endpoint-side mapping decisions and assert with tests per failure scenario.
- **Risk:** Fixing one endpoint may silently regress another.
  **Mitigation:** enforce table-driven tests across all four endpoints in one suite.

Estimated Complexity: medium

## Assignment

- Primary: `dev`
- Parallel: `false`
- Reason: work is concentrated in one service and one handler module with focused regression testing.

## Summary

TASK-034 fixes response-contract mismatches in 1UP seamless callback endpoints so
the API testing suite returns expected status and error codes consistently. The
task is scoped to `Games-Labs-Provider` and emphasizes deterministic error
mapping plus regression coverage for all current failures.

## Blockers

- none

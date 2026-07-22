# TASK-EAR-152: Prevent silent truncation of configured Daily rewards

## Type

Bugfix. Workstream: backend. Priority: high.

## Outcome

Configured Daily rewards must be paid exactly as advertised. A successful
standalone or parent-group claim must return, credit, and persist the configured
reward amount without silently reducing it to the remaining legacy Daily cap.

## Reported evidence

- Mobile rendered `Play Any Game` with a configured reward of `+200`.
- The successful claim modal rendered `+150` from `credited_coins`.
- `mission_logs` recorded `reward_amount = 150` after an earlier same-Bangkok-day
  Daily claim of `100`; the two rows total the legacy cap of `250`.
- Current source loads the fixed activity reward, then truncates it to
  `daily_mission_daily_cap - currentTotal` before wallet credit and persistence.
- `ClaimDailyMissionGroup` applies the same shared-cap truncation to configured
  parent rewards.

## Expected behavior

- A configured standalone reward of `200` produces `credited_coins = 200`, a
  Wallet credit of `200`, and `mission_logs.reward_amount = 200`, even when the
  user already claimed another configured Daily reward in the same Bangkok day.
- A configured parent-group reward is likewise paid in full.
- No configured claim succeeds with a silently reduced amount.
- Existing routes, request/response fields, idempotency behavior, currencies,
  claimability checks, and Bangkok reset boundaries remain unchanged.

## Scope

### Repository

- `Games-Labs-Missions`

### Candidate files

- `internal/services/mission_service.go`
- `internal/services/mission_service_daily_groups.go`
- `internal/services/mission_service_test.go`
- Additional existing focused test file only if that is the local ownership
  pattern; do not create a new abstraction or dependency.

### Explicitly out of scope

- Mobile changes.
- `shared-lib`, protobuf, generated code, or API Gateway changes.
- Backoffice changes.
- Database migrations or historical reward reconciliation.
- Changes to Daily completion bonus, Weekly, Monthly, Check-in, Event, or Invite rewards.
- Retroactive top-up or clawback for claims already completed.

## Implementation plan

1. Reconfirm the two current claim paths and existing tests from source.
2. Determine whether the legacy random Daily fallback (`reward = 0`, random
   min/max) is still reachable in a deployed repository-backed claim flow.
3. Exempt configured fixed standalone rewards from partial-cap truncation and
   pay the loaded activity reward verbatim.
4. Exempt configured parent-group rewards from partial-cap truncation and pay
   the stored group reward verbatim.
5. Preserve the cap only for a verified legacy random fallback if it is still
   required. If correct isolation would require a schema or public-contract
   expansion, stop and return to PM rather than broadening this task.
6. Add focused regressions for standalone and group claims with prior same-day
   child/group reward rows.
7. Run focused and full service verification plus build/vet/diff checks.

## Acceptance criteria

- With an earlier same-day configured claim of `100`, claiming a configured
  standalone reward of `200` returns `credited_coins = 200`.
- The Wallet request and new `mission_logs` row both contain the full configured
  standalone reward and currency.
- Configured parent-group rewards are returned, credited, and persisted in full
  regardless of earlier configured child/group claims in the same day.
- No successful configured standalone/group claim uses the partial formula
  `dailyCap - currentTotal`.
- Claimability, duplicate/idempotency behavior, inactive/not-found errors,
  currencies, and Bangkok-day reset behavior remain covered and unchanged.
- The legacy random fallback is either demonstrably preserved with focused tests
  or documented as unreachable/obsolete and left without speculative new logic.
- No Mobile/shared-lib/proto/gateway/Backoffice/API-shape/database-migration change is made.
- `GOWORK=off go test ./internal/services -count=1`, `GOWORK=off go test ./...`,
  `GOWORK=off go build -mod=readonly ./...`, `GOWORK=off go vet ./...`, and
  `git diff --check` pass in `Games-Labs-Missions`.

## Risks and mitigations

- **Money increase:** users can receive more than the hidden legacy cap.
  Mitigation: limit the change to configured rewards already advertised by the
  API and verify exact Wallet/persistence amounts.
- **Legacy random behavior:** removing all cap code could alter an older random
  flow. Mitigation: prove reachability first and retain only evidence-backed
  legacy behavior.
- **Double credit/idempotency regression:** claim code is money-sensitive.
  Mitigation: preserve existing keys/guards and test duplicate calls.
- **Historical rows:** previous `150` payouts remain unchanged. Mitigation:
  explicitly keep reconciliation out of scope and handle it under a separate
  approved task if Product requests compensation.

## Assignment

Sequential `dev-2` ownership. The source edit is single-service, but payout and
idempotency risk require one owner across implementation and tests.

## Verification

```bash
cd /Users/earth/Documents/GitHub/Games-Labs-Missions
GOWORK=off go test ./internal/services -count=1
GOWORK=off go test ./...
GOWORK=off go build -mod=readonly ./...
GOWORK=off go vet ./...
git diff --check
```

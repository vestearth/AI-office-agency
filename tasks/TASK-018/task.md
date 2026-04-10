# TASK-018: Centralize Redeemable Points Source of Truth in Wallet

## Epic
Points Redemption Reliability and Semantics

## Type
feature

## Priority
critical

## Depends On
- `TASK-013` (Wallet `RedeemPoints` foundation) must be approved and deployed in the target environment.
- If `TASK-014` reward flow is active, behavior must remain compatible.

## Target Services
- `Games-Labs-Missions`
- `Games-Labs-Wallet`
- `shared-lib` (only if request/response contract adjustment is required)

## Target Files
- `Games-Labs-Missions/internal/services/level_service.go`
- `Games-Labs-Missions/internal/clients/wallet/*`
- `Games-Labs-Missions/internal/services/store_service.go` (if redemption is triggered from store paths)
- `Games-Labs-Missions/internal/handlers/*` (error mapping)
- `Games-Labs-Missions/config/*` (Wallet gRPC or HTTP endpoint config)
- `Games-Labs-Wallet/internal/core/services/walletsvc/*` (only if contract/error semantics need alignment)
- `shared-lib/proto/walletpb/*` (only if backward-compatible extension needed)

---

## Overview
`Games-Labs-Missions` currently mutates its own points-like state during redemption.
This creates divergent balances and violates service ownership.

This task enforces a strict model:
- **Wallet owns spendable points balance and point deductions**.
- Missions must treat redemption as an external transactional call to Wallet.
- Missions must not decrement local point balance fields as a side effect of redemption.

---

## Problem Statement
- Local deduction logic in Missions can cause drift from Wallet balances.
- Retries and partial failures can double-deduct or create ghost deductions.
- Operational debugging is harder because there is no single ledger owner.

---

## Objectives

### 1) Remove local spendable-point deduction in Missions
- Remove all code paths that reduce local points for redemption (for example in level/store services).
- Keep local progression fields for level/EXP semantics only.

### 2) Use Wallet redemption API for all point spending
- Introduce/complete Missions wallet adapter client that calls Wallet redemption (`RedeemPoints`).
- Pass deterministic idempotency keys from Missions use-cases.
- Include reason/source metadata (e.g. `missions_store_purchase`, `missions_reward_claim`).

### 3) Ensure proper error translation
- Map Wallet errors to stable API responses:
  - insufficient points -> `402 Payment Required` (or currently accepted contract code)
  - invalid request -> `400 Bad Request`
  - transient upstream failure -> `503 Service Unavailable`
- Preserve error code consistency across all redemption endpoints.

### 4) Idempotency and retry safety
- Ensure repeated same request with same idempotency key does not deduct twice.
- Ensure timeout/retry behavior is safe and documented.

### 5) Observability
- Add structured logs with correlation fields: `user_id`, `idempotency_key`, `reason`, `wallet_reference`.
- Add metrics counter for redemption attempts/success/fail by reason.

---

## Non-Goals
- No redesign of level/EXP progression rules (handled in TASK-019).
- No distributed saga/refund design (handled in TASK-020).
- No dynamic rate/cost catalog redesign (handled in TASK-021).

---

## Acceptance Criteria
- [ ] No Missions code path directly decrements spendable points state for redemption.
- [ ] Every redemption flow in Missions calls Wallet redemption via adapter/client.
- [ ] Duplicate requests with same idempotency key do not double-deduct points.
- [ ] Wallet insufficient-points responses are surfaced with agreed API status/message.
- [ ] End-to-end test proves Wallet balance is authoritative after redemption.
- [ ] Logs include correlation fields needed for audit and incident triage.
- [ ] Existing public API behavior remains backward compatible unless explicitly documented.

---

## Test Plan
1. **Happy Path**
   - User with enough wallet points redeems once.
   - Verify Wallet points reduced exactly once; Missions returns success.
2. **Duplicate Submission**
   - Replay with same idempotency key.
   - Verify same outcome response, no additional deduction.
3. **Insufficient Points**
   - Wallet returns insufficient balance.
   - Verify Missions returns mapped error and no local fallback deduction occurs.
4. **Wallet Timeout / 5xx**
   - Simulate Wallet outage.
   - Verify Missions returns retriable failure and does not mutate local points.

---

## Risks and Mitigations
- **Risk:** Existing clients rely on legacy local deduction side effects.
  - **Mitigation:** keep response schema stable; communicate behavior migration in release notes.
- **Risk:** Partial migration leaves one endpoint still using local mutation.
  - **Mitigation:** code search guardrail + targeted regression tests for all redemption entry points.
- **Risk:** Incorrect idempotency key composition causes accidental collisions.
  - **Mitigation:** standardize format `missions:<flow>:<user_id>:<request_id>`.

---

## Assigned Agent
`dev-2`

## Reviewer Focus
- Verify no local deduction remains.
- Verify all redemption routes go through Wallet adapter.
- Verify idempotency behavior with repeated requests and timeout scenarios.

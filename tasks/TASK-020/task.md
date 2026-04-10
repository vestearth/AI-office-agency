# TASK-020: Add Refund/Rollback for Points with Saga Compensation

## Epic
Points Redemption Reliability and Semantics

## Type
feature

## Priority
critical

## Depends On
- `TASK-018` (Wallet as source of truth for spending) must be complete.
- `TASK-019` semantic separation should be complete or in final review.

## Target Services
- `Games-Labs-Wallet`
- `Games-Labs-Missions`
- `Games-Labs-Order` (if it uses point spending in reward/store flows)
- `shared-lib` (wallet proto contract)

## Target Files
- `shared-lib/proto/walletpb/wallet.proto`
- `Games-Labs-Wallet/internal/core/services/walletsvc/*`
- `Games-Labs-Wallet/internal/core/repositories/*`
- `Games-Labs-Wallet/internal/core/handlers/*` (gRPC/HTTP mapping)
- `Games-Labs-Missions` and/or `Games-Labs-Order` orchestration service layer files
- migration files for idempotency/ledger tracking if new tables/columns are needed

---

## Overview
Current redemption can fail after Wallet has already deducted points, causing irreversible user loss.
This task introduces a compensation mechanism (refund) and saga-style orchestration so downstream failures are recoverable and auditable.

---

## Design Principles
- Prefer **explicit compensation** (`RefundPoints`) over implicit negative redemption calls.
- All redeem/refund actions must be idempotent and traceable with correlation IDs.
- Compensation must be safe for retries and partial outages.
- Ledger/audit entries must prove final financial correctness.

---

## Objectives

### 1) Extend Wallet contract
- Add `RefundPoints` RPC in `walletpb` with request fields:
  - `user_id`
  - `points`
  - `reason`
  - `idempotency_key`
  - `reference_redemption_id` (or equivalent)
- Add response with resulting `points_after` and reference metadata.

### 2) Wallet implementation
- Implement atomic point refund in Wallet service/repository.
- Enforce idempotency uniqueness at DB level.
- Validate that refund references a known successful redemption (prevent arbitrary minting).

### 3) Saga orchestration in caller service(s)
- For flows that spend points then perform downstream work:
  1. `RedeemPoints`
  2. Execute business action
  3. If step 2 fails, call `RefundPoints` compensation
- Persist saga state transitions for observability and replay.

### 4) Retry and failure policy
- Define deterministic retry policy for compensation failures.
- Add dead-letter/manual-recovery operational path when automatic compensation exhausts retries.

### 5) Audit and reconciliation
- Ensure all redemption/refund pairs can be reconciled by `user_id + correlation_id`.
- Add periodic check/report query for unmatched redemptions.

---

## Non-Goals
- Full distributed transaction coordinator framework adoption beyond scoped flows.
- Pricing/rate catalog redesign (TASK-021).

---

## Acceptance Criteria
- [ ] `RefundPoints` contract exists in `walletpb` and generated code is updated.
- [ ] Wallet refund implementation is idempotent and validated against prior redemption reference.
- [ ] At least one redemption flow (Missions or Order) executes saga compensation on downstream failure.
- [ ] Duplicate compensation requests do not over-credit.
- [ ] Structured logs and metrics expose redemption/refund lifecycle and final status.
- [ ] Reconciliation query/report can detect unresolved redemptions.

---

## Test Plan
1. **Redeem Success**
   - Redeem + downstream success; no refund should execute.
2. **Downstream Failure with Compensation Success**
   - Redeem succeeds, business step fails, refund succeeds.
   - Net points change must be zero.
3. **Compensation Retry**
   - Force temporary refund failure then retry.
   - Verify eventual consistency and no over-credit.
4. **Duplicate Refund Call**
   - Replay same refund idempotency key.
   - Verify single credit effect.

---

## Risks and Mitigations
- **Risk:** Missing redemption reference validation enables abuse.
  - **Mitigation:** enforce refund only against successful redemption records.
- **Risk:** Compensation fails permanently and user remains deducted.
  - **Mitigation:** add DLQ/manual recovery + alerting thresholds.
- **Risk:** Race conditions between retries and manual operations.
  - **Mitigation:** transactional state checks and idempotent keys on both redeem and refund.

---

## Assigned Agent
`dev-2`

## Reviewer Focus
- Verify financial correctness and no double-credit/double-deduct in retry storms.
- Verify operational recovery path exists when automatic compensation fails.

# TASK-022: Centralize Redeemable Points Source of Truth in Wallet

Epic: Points Redemption Reliability and Semantics

Type: feature

Priority: critical

Depends On:
- TASK-013 (Wallet RedeemPoints foundation must be approved and deployed)
- If TASK-014 reward flow is active, maintain compatibility

Target Services:
- Games-Labs-Missions
- Games-Labs-Wallet
- shared-lib (only if contract changes required)

Target Files:
- Games-Labs-Missions/internal/services/level_service.go (modify) — remove local spendable deduction logic
- Games-Labs-Missions/internal/clients/wallet/* (create/modify) — implement Missions wallet adapter and redemption client
- Games-Labs-Missions/internal/services/store_service.go (modify) — route store redemption through wallet client if present
- Games-Labs-Missions/internal/handlers/* (modify) — map wallet errors to stable API responses
- Games-Labs-Missions/config/* (modify) — add/configure Wallet endpoint and timeouts
- Games-Labs-Wallet/internal/core/services/walletsvc/* (modify only if contract alignment required)
- shared-lib/proto/walletpb/* (create/modify only if extending grpc contract)

Overview:
Missions currently mutates local points state during redemption, causing drift vs Wallet. This task centralizes spendable-point ownership in Wallet: Missions must call Wallet's RedeemPoints for all spend operations and must not decrement local spendable-point fields.

Objectives:
1) Remove local spendable-point deduction in Missions; keep progression fields for level/EXP only.
2) Route all redemption flows through the Wallet redemption API using a Missions wallet adapter.
3) Provide deterministic idempotency keys per request and include reason metadata.
4) Map wallet errors to stable API responses consistently across handlers.
5) Add observability: structured logs and redemption metrics.

Acceptance Criteria:
- No Missions code path directly decrements spendable points for redemption.
- Every redemption flow in Missions calls Wallet redemption via adapter/client.
- Duplicate requests with same idempotency key do not double-deduct points.
- Wallet insufficient-points responses are surfaced with agreed API status/message.
- End-to-end test proves Wallet balance is authoritative after redemption.
- Logs include correlation fields: user_id, idempotency_key, reason, wallet_reference.
- Existing public API behavior remains backward compatible unless documented.

Test Plan:
1. Happy Path: user with sufficient points redeems; Wallet balance reduced once; Missions returns success.
2. Duplicate Submission: replay same idempotency key; verify idempotent behavior and no extra deduction.
3. Insufficient Points: Wallet rejects; Missions returns mapped error; no local deduction.
4. Wallet Timeout/5xx: simulate outage; Missions returns retriable failure and no local mutation.

Risks and Mitigations:
- Clients rely on legacy local deductions — mitigate via stable response schema and release notes.
- Partial migration leaves endpoints with local mutation — mitigate via code search and regression tests.
- Idempotency key collisions — standardize format: missions:<flow>:<user_id>:<request_id>.

Assigned Agent: dev-2

Reviewer Focus:
- Ensure no local deduction remains; verify all redemption routes use wallet adapter; validate idempotency behavior.

# Dev-2 Assignment — TASK-009

You are working on **subtasks 3, 4, 6** of TASK-009 (E2E Verification).

## Your Subtasks

### Subtask 3: Wallet Service Unit Tests
Write unit tests covering:
- **ExchangeDiamondsToCoins:** happy path + insufficient balance + idempotent replay
- **RewardPackage:** both currencies + single currency + idempotent replay

**File:** `Games-Labs-Wallet/internal/core/services/walletsvc/service_test.go`

### Subtask 4: Integration Test Infrastructure
Create reusable test infrastructure:
- Test DB setup/teardown using pgxpool test containers or local DB
- Seed test data (packages, users with wallets)
- Helper functions for common assertions

**File:** `Games-Labs-Order/tests/integration/testhelpers_test.go` (create)

### Subtask 6: Missions Integration Verification (Phase 2)
TASK-008 is complete — this subtask is now unblocked.

Verify Missions integration:
- `USE_ORDERS_CATALOG=true` -> ListPackages returns Orders data
- PurchasePackage delegates to Orders CreatePurchaseOrder
- ExchangeDiamonds delegates to Orders CreateExchangeOrder
- Pass/avatar logic still works independently

**File:** `Games-Labs-Missions/internal/services/store_service_test.go` (create or modify)

## Coordination
- Dev is handling subtasks 1, 2, 5 (Order mocks + Order unit tests + integration tests)
- Your subtask 4 (test infra) will be used by Dev's subtask 5 — prioritize this first
- After you finish, set `next_action.agent: reviewer`

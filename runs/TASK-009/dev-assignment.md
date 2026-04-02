# Dev Assignment — TASK-009

You are working on **subtasks 1, 2, 5** of TASK-009 (E2E Verification).

## Your Subtasks

### Subtask 1: Mock Implementations
Write mock implementations for `WalletAdapter`, `BoosterPassAdapter`, and `OrderRepo`
interfaces in the ordersvc test file. Use table-driven test patterns.

**File:** `Games-Labs-Order/internal/core/services/ordersvc/service_test.go`

### Subtask 2: Order Service Unit Tests
Write unit tests covering:
- **Purchase:** CreateOrderFromPackage happy path + inactive/expired package rejection
- **Exchange:** CreateExchangeOrder happy path + insufficient diamonds + booster bonus
- **Fulfillment:** ConfirmPayment flow (pending -> fulfilled), duplicate callback, retry after failure
- **Package:** UpsertPackage time-window validation, code uniqueness check

**File:** `Games-Labs-Order/internal/core/services/ordersvc/service_test.go`

### Subtask 5: Integration Tests (Purchase + Exchange + Reconciliation)
Write integration tests for:
- Purchase and exchange happy paths
- Concurrent exchange (race condition)
- Reconciliation queries (fulfilled orders match wallet operations)

**Files:**
- `Games-Labs-Order/tests/integration/purchase_test.go` (create)
- `Games-Labs-Order/tests/integration/exchange_test.go` (create)

Use `//go:build integration` build tag to separate from unit tests.

## Coordination
- Dev-2 is handling subtasks 3, 4, 6 (Wallet tests + test infra + Missions integration)
- Your subtask 5 depends on subtask 4 (test infra) — if Dev-2 hasn't finished yet, write the test structure and use stubs for DB helpers
- After you finish, set `next_action.agent: reviewer`

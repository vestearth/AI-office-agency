# TASK-EAR-103: Implement transactional Coupon backend

Parent `TASK-EAR-101`; blocked by published `TASK-EAR-102`. Feature/backend/high; `dev-2`.

In Order, bump published shared-lib, add approved coupon fields and coupon-use ledger migration, harden Admin CRUD, and implement authenticated validate/apply/consume behavior transactionally. Resolve server price, package/VIP/status/window/quotas; persist coupon and discount/reward snapshot on the order; make retry, settlement and refund follow TASK-EAR-101. Expose only through api-gateway.

Affected: `Games-Labs-Order/internal/models/coupon.go`, `internal/core/repositories/coupon.go`, `internal/core/services/ordersvc/coupon.go`, handlers/order flow, migrations/tests, `go.mod/go.sum`; `api-gateway/gateway/grpc.go` and dependency files.

Acceptance: Admin fields round-trip; quota/ledger atomic under concurrency; stable errors; authoritative calculation; idempotent retry; settlement/refund tested; readonly builds/no replace; gateway smoke plan recorded.


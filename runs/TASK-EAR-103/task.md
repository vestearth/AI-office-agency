# TASK-EAR-103: Implement transactional Coupon backend

Parent `TASK-EAR-101`; blocked by published `TASK-EAR-102`. Feature/backend/high; `dev-2`.

In Order, bump published shared-lib, add approved coupon fields and coupon-use ledger migration, harden Admin CRUD, and implement authenticated validate/apply/consume behavior transactionally. Resolve server price, package/VIP/status/window/quotas; persist coupon and discount/reward snapshot on the order; make retry, settlement and refund follow TASK-EAR-101. Expose only through api-gateway.

Affected: `Games-Labs-Order/internal/models/coupon.go`, `internal/core/repositories/coupon.go`, `internal/core/services/ordersvc/coupon.go`, handlers/order flow, migrations/tests, `go.mod/go.sum`; `api-gateway/gateway/grpc.go` and dependency files.

## Scope correction — cursor-agent investigation 2026-07-14

A read-only investigation (cursor-agent, backed by direct file citations) found that
the raw gRPC `OrderService.CreateOrder` — the only RPC TASK-EAR-102 added
`coupon_code` to — is **not** the live purchase path. api-gateway does register
it publicly (`gateway/grpc.go` ~84, `gateway/http.go` ~102-120, JWT-gated, not
admin-gated), but no Games-Labs service actually calls it. The real path for a
real user today is:

```
Client -> gateway (JWT) -> Missions gRPC-gateway StorePurchase (missions.proto ~222-226)
  -> handlers/mission/http/store.go ~99-119 CreatePurchase
  -> store_service.go ~374-415 orderClient.CreatePurchaseOrder
  -> Games-Labs-Missions/clients/order/client.go ~104-120 (plain HTTP, NOT gRPC)
       POST .../api/v1/orders/from-package  (and a separate .../orders/exchange path)
  -> Games-Labs-Order cmd/main.go ~99-101 (HTTP-only route, not gateway-proxied)
  -> orderhdl/http.go ~65-92 -> ordersvc.CreateOrderFromPackage ~101-162
  -> ordersvc.CreateOrder ~68-98 (status pending) -> repositories/order.go ~27-40 INSERT
```

Fulfillment is a separate hop: `pending -> ConfirmPayment` (`service.go`
~542-573) -> wallet `RewardPackage` -> `fulfilled`; Missions can proxy confirm
via `ConfirmOrderPayment` (~1216-1223) or the store payment webhook
(`store.go` ~350-371).

This means TASK-EAR-102's `CreateOrderRequest.coupon_code` (gRPC) is necessary
but not sufficient. To actually thread a coupon through a real purchase, this
task must also:

- Add `coupon_code` to Order's plain HTTP `from-package` and `exchange`
  request models/handlers (`Games-Labs-Order/internal/models/order.go`,
  `orderhdl/http.go`, `ordersvc.CreateOrderFromPackage`/`CreateOrder`) — these
  are NOT protobuf-typed, they are Order's own internal HTTP contract.
- Add `coupon_code` to `Games-Labs-Missions/internal/services/store_service.go`
  `CreatePurchase` and to `clients/order/client.go`'s `CreatePurchaseOrder` /
  exchange call, so it actually reaches Order from the real client-facing
  `StorePurchase` endpoint. **`Games-Labs-Missions` is now an affected repo**,
  not just Order and api-gateway.
- Wire the gRPC `OrderService.CreateOrder` handler
  (`Games-Labs-Order/.../orderhdl/grpc.go` ~28-46) to actually pass through
  `coupon_code` too, since it is a registered public route even though unused
  today — do not leave it silently ignoring a field callers may set.

## Reuse existing precedents instead of inventing new ones

- **Reservation pattern:** Missions `ReserveStorePurchase` ->
  `store_purchase_operations` reserved state (`store_repo.go` ~231-252) is a
  directly analogous existing reserve-then-confirm pattern for the coupon
  usage ledger to mirror.
- **Atomic quota precedent:** `RedeemRedemptionItem` locks the item
  `FOR UPDATE`, checks quota, then increments (`redemption.go` ~759-886) —
  reuse this same lock-check-increment shape and its existing Asia/Bangkok
  day-boundary logic for the coupon ledger instead of a new mechanism.
- **Idempotency precedent:** `GetByIdempotencyKey` on package/exchange create
  (`service.go` ~109-116, ~180+) is the existing idempotent-hold pattern.

Acceptance: Admin fields round-trip; quota/ledger atomic under concurrency
(reusing the Redemption FOR UPDATE pattern); stable errors (5023-5031); coupon_code
actually reaches Order from the real Missions store-purchase path, not only the
unused gRPC CreateOrder route; idempotent retry; settlement/refund tested;
readonly builds/no replace; gateway smoke plan recorded.


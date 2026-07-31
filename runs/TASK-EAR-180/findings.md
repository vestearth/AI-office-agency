# TASK-EAR-180 — Order authorization audit findings

Read-only audit, 2026-07-31, against `Games-Labs-Order` `staging` @ `c0a7b06`.
Scope of this run is the two endpoints named at intake; the audit swept the
whole handler layer as the task required and found more. Everything below is
evidence-backed with file:line.

## 1. The two in-scope endpoints — confirmed, and one is worse than "IDOR"

### `ListOrders` — `GET /api/v1/orders`

- Handler `internal/core/handlers/orderhdl/grpc.go:158-194`; service
  `ordersvc/service.go:729-734`; repo `repositories/order.go:112-147`.
- `user_id` arrives as a **query parameter** (gateway binding
  `orderpb/order.pb.gw.go:134-150` → `PopulateQueryParameters`) and is passed
  through to the repo with no ownership check at any layer.
- 🔴 **Full-table dump, not just a targeted read.** The repo only adds the
  `WHERE` clause when the pointer is non-nil (`order.go:117-121`), so
  `GET /api/v1/orders` with **no** `user_id` and any valid player token
  returns **every order for every user, unpaginated**.

### `ListMyRedemptionItems` — `GET /api/v1/my-redemption-items`

- Handler `orderhdl/grpc.go:394-436`; service `service.go:1179-1193`; repo
  `repositories/redemption.go:918-962`.
- `user_id` is likewise a query parameter; the service checks only that it is
  non-empty. Any authenticated caller can read another player's redeemed
  vouchers **and their codes**.

Both are reachable by any authenticated player: the gateway token-gates
`/api/*` (`api-gateway/gateway/http.go:90-103`) but `RequireAdminAPIAccess()`
only guards the `/api/v1/admin` prefix.

## 2. 🔴 Out-of-scope findings with a LARGER blast radius — operator decision needed

These are the same defect class on the same handler file. They were found by
the sweep this task mandated. **Not fixed in this run** — flagged for an
explicit in-or-out decision rather than folded in silently.

| Endpoint | file:line | Why it is worse |
| --- | --- | --- |
| `POST /api/v1/orders/{id}/confirm-payment` | `grpc.go:224-245`, `http.go:278-313` | **No caller check at all.** `service.go:602-641` transitions `PENDING → PAYMENT_CONFIRMED` and calls `fulfillOrder`, which **credits the wallet**. Any authenticated player can drive another player's order to fulfilment — a money path, not a read. |
| `PATCH /api/v1/orders/{id}/status` | `grpc.go:196-222` | No ownership **and no staff** check. Any authenticated player can set any order's status. |
| `POST /api/v1/redemptions/{id}/redeem` | `grpc.go:376-392` | **Write IDOR**: `UserID` from the JSON body — redeem against a victim's point balance. |
| `POST /api/v1/orders` (CreateOrder) | `grpc.go:28-47` | `user_id` from body — create an order attributed to another user. |
| `POST /api/v1/orders/validate-coupon` | `grpc.go:61-70` | `user_id` from body — probe another user's coupon eligibility / VIP gating. |
| `GET /api/v1/orders/{id}` (GetOrder) | `grpc.go:96-117` | No ownership check — any order readable by id. |

Ambiguous, flagged not claimed: `PaymentCallback` (`grpc.go:247-268`) is
unauthenticated on the pod's own mux but has **no gateway route** (Gin
forwards only `/api/*`, `/admin/*`, `/uploads/*`, `/assets/*`, `/health`), so
it is internal-network only — a defence-in-depth question, not an IDOR.

## 3. Clean surfaces — verified, no change needed

- **`adminorderhdl`**: all 47 methods walked programmatically; every gRPC
  method calls `auth.RequireStaffGRPC`/`RequireStaffMetadata`, every HTTP
  handler calls `requireStaffHTTP` (`adminorderhdl.go:98-141`).
- **`weborderhdl`**: catalog reads only, no user-scoped data.
- **`orderhdl` HTTP handlers** already on header-first identity:
  `CreateOrderFromPackageHTTP` (`http.go:74-131`),
  `CreateExchangeOrderHTTP` (`http.go:133-187`),
  `CreateRewardOrderHTTP` (`http.go:229-276`).

## 4. The admin flow is NOT at risk — the key design question, answered

Backoffice Player Detail "Purchase > Package history" does **not** ride on the
vulnerable endpoint. It calls the staff-gated admin route:

- FE `useAdminPlayerPurchaseHistory.ts:84-92` →
  `GET /api/v1/admin/orders/user/{user_id}`
- Proto `adminorderpb/adminorder.proto:165-167`; handler
  `adminorderhdl.go:537-540` with
  `auth.RequireStaffGRPC(ctx, auth.PERM_ORDER_MANAGEMENT)`; additionally
  behind the gateway's `/api/v1/admin` guard.
- It uses its own additive repo query (`order.go:151-187`
  `ListPaginated`/`CountOrders`), deliberately not sharing `ListOrders` — the
  comment at `order.go:150-153` says so.

Swept the whole Backoffice for `/api/v1/orders` and `my-redemption-items`:
one hit, the admin route above. No sibling Go service calls either endpoint
(all eight repos grepped); Missions only uses the HTTP `from-package` /
`exchange` / `confirm-payment` routes.

**Therefore scoping these two endpoints to the caller's own identity breaks
nothing.** One residual gap noted, not a blocker: there is no admin
equivalent of `ListMyRedemptionItems` (`adminorder.proto` has
`GrantRedemptionItem` but no list-a-player's-vouchers RPC). If an admin
voucher-history panel is ever wanted it needs a new admin RPC.

## 5. ⚠️ Implementation trap — the header pattern does NOT transfer

`ListOrders` / `ListMyRedemptionItems` are **gRPC** handlers with no
`*http.Request`, so the `r.Header.Get("X-User-ID")` block used by the HTTP
handlers cannot be copied. Identity arrives as gRPC **metadata**:

- `api-gateway/middleware/identity_headers.go:10-23` strips any
  client-supplied `X-User-ID`/`userid` and re-sets **`userid`** from the
  validated token.
- `api-gateway/interceptor/metadata.go:16-22` maps it into gRPC metadata key
  **`userid`** (wired at `gateway/grpc.go:65`).

`shared-lib/pkg/auth.ConvertMetaDataToUserData` exposes this as `td.UserId`
but **requires `role`, `userid` AND `access` all present** or returns
`MetaDataNotFound`. All three do arrive for a player call today, but that
coupling is brittle for an endpoint needing one field — read the `userid`
metadata key directly via a small local helper.

Error handling: `writeServiceError` (the numeric-code-preserving writer) is
HTTP-mux-only and does not apply here; gRPC handlers return
`basepb.StatusResponse` via `errormsg.ToStatus`, which preserves codes
natively. Use `errormsg.MetaDataNotFound` (1003 → HTTP 401) when identity is
absent.

## 6. Test house pattern

Plain stdlib `testing`, no assertion library; stubs embed the wide
`ports.OrderService` interface and override only what they need.

- Closest precedent — the TASK-EAR-085 identity regression test:
  `orderhdl/http_test.go:17-49`.
- Metadata-injection fixture to mirror for the gRPC side:
  `adminorderhdl/special_item_test.go:66-72` (`staffContext()`); the natural
  counterpart is a `playerContext(userID)` in `orderhdl`.

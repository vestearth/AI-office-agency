# TASK-EAR-182 — Order: close the remaining authorization holes (4 endpoints)

## Type

bugfix

## Workstream

backend

## Priority

high

## Created

2026-07-31

## Epic

Order authorization hardening. Follows TASK-EAR-180, which fixed the two
read-side endpoints it was scoped to and surfaced these four. Operator
approved doing all four in one run (chat, 2026-07-31).

## Context

TASK-EAR-180's mandated sibling sweep found four more authorization defects of
the same class on `internal/core/handlers/orderhdl/grpc.go`. They were left out
of that PR on purpose — larger blast radius, and folding them in silently would
have hidden a real scope change. Per-endpoint evidence with file:line is in
`runs/TASK-EAR-180/findings.md`; read it before starting.

All four are reachable today by **any authenticated player**: api-gateway
token-gates `/api/*` but `RequireAdminAPIAccess()` only guards the
`/api/v1/admin` prefix. They are live on staging now, and will reach prod when
the consolidated prod patch ships.

## The four defects

Ordered by blast radius. **1 and 2 are money/state paths, not reads.**

1. **`POST /api/v1/orders/{id}/confirm-payment`** — `grpc.go:224-245`,
   `http.go:278-313`. No caller check at all. `ordersvc/service.go:602-641`
   transitions `PENDING → PAYMENT_CONFIRMED` and calls `fulfillOrder`, **which
   credits the wallet**. Any authenticated player can drive another player's
   order to fulfilment.
   ⚠️ Note this endpoint is also called service-to-service by Missions (HTTP
   route) — see "Do not break" below.
2. **`PATCH /api/v1/orders/{id}/status`** — `grpc.go:196-222`. Neither
   ownership nor staff check. Any authenticated player can set any order's
   status. Decide deliberately whether this should be **staff-only** rather
   than owner-scoped; a player arbitrarily setting order status is not an
   obvious user capability.
3. **`POST /api/v1/redemptions/{id}/redeem`** — `grpc.go:376-392`. Write IDOR:
   `UserID` comes from the JSON body (`body: "*"`), so a caller can redeem
   against a victim's point balance.
4. **Body/path-supplied identity, no ownership check** —
   `POST /api/v1/orders` (`grpc.go:28-47`),
   `POST /api/v1/orders/validate-coupon` (`grpc.go:61-70`),
   `GET /api/v1/orders/{id}` (`grpc.go:96-117`, any order readable by id).

## Approach

Reuse the helpers TASK-EAR-180 added — `callerUserID` / `callerUUID` in
`internal/core/handlers/orderhdl/caller_identity.go`. They read the
gateway-set `userid` gRPC metadata key (populated from the validated token
after any client-supplied value is stripped) and fail closed with
`MetaDataNotFound`. Do **not** reach for `r.Header.Get("X-User-ID")` on the
gRPC handlers — no `*http.Request` exists there.

For staff-gated endpoints use the existing `auth.RequireStaffGRPC(ctx, perm)`
pattern already used throughout `adminorderhdl` (see
`adminorderhdl.go:98-141`).

For owner-scoped reads of a single object (`GetOrder`), the check is
"caller owns the fetched row", not "caller supplied an id" — fetch, then
compare, then 403.

## Do not break

- **`confirm-payment` has a service-to-service caller.** Missions calls the
  HTTP route (`Games-Labs-Missions/internal/clients/order/client.go`). Verify
  how that call authenticates before locking the endpoint — an internal caller
  may not carry a player `userid`. Determine the right rule (internal/service
  identity vs owner) **before** implementing, and record it. Breaking this
  path breaks purchases.
- Admin surfaces: `adminorderhdl` is already fully staff-gated (all 47 methods
  verified in TASK-EAR-180's audit) — do not duplicate guards there.
- Keep proto fields on the wire even when their value stops being trusted, as
  TASK-EAR-180 did, so well-behaved clients are unaffected.

## Test integrity (non-negotiable)

Every fix ships with a regression test **seen failing before the fix**.
Follow the house pattern established in
`orderhdl/caller_identity_test.go` (TASK-EAR-180): stdlib `testing`, stub
embeds `ports.OrderService` and overrides only the method under test,
`playerContext(userID)` injects gRPC metadata. Record the red run in the run
notes, not just the green one.

## Acceptance Criteria

- All four defect groups closed; each has a regression test that was red first.
- Cross-user attempts return an authorization error on staging, verified live
  through api-gateway (not only in unit tests).
- The Missions → `confirm-payment` service-to-service path still works on
  staging, verified with a real purchase flow.
- The staff-vs-owner decision for `UpdateOrderStatus` is written down with its
  rationale, not just implemented.
- `go build` / `go vet` / `go test ./...` green. PR targets `staging`.
- Anything found and deliberately not fixed is recorded, as TASK-EAR-180 did.

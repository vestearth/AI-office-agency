# TASK-EAR-182 — Order: close the remaining authorization holes (3 endpoints)

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
read-side endpoints it was scoped to and surfaced these findings. Operator
initially approved doing all four in one run (chat, 2026-07-31), then split
`confirm-payment` out into its own critical-priority run — see
"Scope change" below.

## Scope change (2026-07-31)

**`confirm-payment` moved to [[TASK-EAR-185]].** Operator request in chat:
"แยก confirm-payment เป็น run แยกเลย รีบสุด" — it is the only one of the four
that is a money path (reaches `fulfillOrder`, credits the wallet), so it
should not wait behind the other three, which are reads/state-writes with no
direct money movement. This run now owns only the three below.

## Context

TASK-EAR-180's mandated sibling sweep found these authorization defects of
the same class on `internal/core/handlers/orderhdl/grpc.go`. They were left
out of that PR on purpose — larger blast radius, and folding them in silently
would have hidden a real scope change. Per-endpoint evidence with file:line is
in `runs/TASK-EAR-180/findings.md`; read it before starting.

All three are reachable today by **any authenticated player**: api-gateway
token-gates `/api/*` but `RequireAdminAPIAccess()` only guards the
`/api/v1/admin` prefix. They are live on staging now, and will reach prod when
the consolidated prod patch ships.

## The three remaining defects

Ordered by blast radius.

1. **`PATCH /api/v1/orders/{id}/status`** — `grpc.go:196-222`. Neither
   ownership nor staff check. Any authenticated player can set any order's
   status. Decide deliberately whether this should be **staff-only** rather
   than owner-scoped; a player arbitrarily setting order status is not an
   obvious user capability.
2. **`POST /api/v1/redemptions/{id}/redeem`** — `grpc.go:376-392`. Write IDOR:
   `UserID` comes from the JSON body (`body: "*"`), so a caller can redeem
   against a victim's point balance.
3. **Body/path-supplied identity, no ownership check** —
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

- All three defect groups closed; each has a regression test that was red first.
- Cross-user attempts return an authorization error on staging, verified live
  through api-gateway (not only in unit tests).
- The staff-vs-owner decision for `UpdateOrderStatus` is written down with its
  rationale, not just implemented.
- `go build` / `go vet` / `go test ./...` green. PR targets `staging`.
- Anything found and deliberately not fixed is recorded, as TASK-EAR-180 did.

## Related

- `ai-dev-office/runs/TASK-EAR-185/` — `confirm-payment`, split out of this
  run as the critical-priority money path.

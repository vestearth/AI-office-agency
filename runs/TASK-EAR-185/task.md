# TASK-EAR-185 — Order: close confirm-payment authorization hole (critical, wallet-crediting)

## Type

bugfix

## Workstream

backend

## Priority

critical

## Created

2026-07-31

## Epic

Order authorization hardening. Split out of TASK-EAR-182 at operator request
(2026-07-31 chat, "แยก confirm-payment เป็น run แยกเลย รีบสุด") because this
single endpoint is the most severe of the four TASK-EAR-180 sibling findings —
it is a money path, not a read — and should not wait behind the other three.
TASK-EAR-182 continues to own the remaining three (`UpdateOrderStatus`,
`RedeemRedemptionItem`, body/path identity on CreateOrder/validate-coupon/GetOrder).

## Context

TASK-EAR-180's mandated sibling sweep found this defect on
`internal/core/handlers/orderhdl/grpc.go`. Full evidence:
`ai-dev-office/runs/TASK-EAR-180/findings.md` (§2, row 1).

## The defect

**`POST /api/v1/orders/{id}/confirm-payment`** — `grpc.go:224-245`,
`http.go:278-313`. **No caller check at all.**
`ordersvc/service.go:602-641` transitions `PENDING → PAYMENT_CONFIRMED` and
calls `fulfillOrder`, **which credits the wallet**. Any authenticated player
can drive another player's order to fulfilment — this moves money, it is not
a read like the two endpoints TASK-EAR-180 already fixed.

Reachable today by any authenticated player: api-gateway token-gates `/api/*`
but `RequireAdminAPIAccess()` only guards the `/api/v1/admin` prefix. Live on
staging now; will reach prod when the consolidated prod patch ships.

## Hard prerequisite — do this before writing the fix

**`confirm-payment` has a service-to-service caller.** Missions calls this
HTTP route directly (`Games-Labs-Missions/internal/clients/order/client.go`).
Before locking the endpoint down:

1. Read that client to see exactly how it calls this route today (auth
   headers/metadata it does or does not send).
2. Determine whether that call carries a player `userid` the caller-scope
   check could validate against, or whether it needs a distinct
   internal-service-identity rule (e.g. a service-to-service credential,
   or scoping to "the order's own owner" resolved server-side instead of a
   caller-supplied id).
3. **Write the decision down in the run notes before implementing.** Breaking
   this path breaks real purchases — this is the one place in the whole
   TASK-EAR-180/182/185 family where "just require caller == owner" may not
   be the correct rule.

## Approach

Reuse the helpers TASK-EAR-180 added — `callerUserID` / `callerUUID` in
`internal/core/handlers/orderhdl/caller_identity.go`. They read the
gateway-set `userid` gRPC metadata key (populated from the validated token
after any client-supplied value is stripped) and fail closed with
`MetaDataNotFound`. Do **not** reach for `r.Header.Get("X-User-ID")` — no
`*http.Request` exists on this handler.

If the Missions service-to-service call needs different treatment than a
player caller, keep the player-facing path's fail-closed behavior and add
whatever the internal-caller rule turns out to require explicitly — do not
weaken the check for everyone to accommodate one caller.

## Do not break

- The Missions → `confirm-payment` purchase flow. Verify with a real purchase
  on staging after the fix, not only unit tests.
- Keep the `user_id` proto field on the wire even though its value stops
  being trusted for authorization, matching the TASK-EAR-180 pattern, so
  well-behaved clients are unaffected.

## Test integrity (non-negotiable)

Ship a regression test **seen failing before the fix**. Follow the house
pattern in `orderhdl/caller_identity_test.go` (TASK-EAR-180): stdlib
`testing`, stub embeds `ports.OrderService` and overrides only the method
under test, `playerContext(userID)` injects gRPC metadata for the
cross-user-denied case. Add a second case for whatever the internal-caller
rule turns out to be.

## Acceptance Criteria

- The service-to-service identity question is answered and written down
  before implementation starts.
- Cross-user confirm-payment attempts are denied, verified live through
  api-gateway on staging (not only in unit tests).
- The Missions purchase flow still completes successfully on staging after
  the fix, verified with a real purchase.
- Regression test seen RED before the fix, green after.
- `go build` / `go vet` / `go test ./...` green. PR targets `staging`.
- Anything found and deliberately not fixed is recorded.

## Related

- `ai-dev-office/runs/TASK-EAR-180/` — found this defect, fixed the two
  read-side siblings.
- `ai-dev-office/runs/TASK-EAR-182/` — the other three siblings, descoped
  from this endpoint at operator request.

# TASK-EAR-117 — Fix coupon-public-contract.md apply-path + publish Mobile API list

## Context

Operator asked whether FE/Mobile has an API to fetch Coupon and Special Item
data (Backoffice config for both is already delivered under EAR-101..105).
Investigation (Explore agent, 2026-07-15) found `Games-Labs-Order/docs/coupon-public-contract.md`
documents APPLY as a direct client call to `POST /api/v1/orders/from-package`
and `POST /api/v1/orders/exchange`, but api-gateway has no route registered
for either path — grep across `api-gateway/**/*.go` for `from-package` and
`orders/exchange` returns no hits. The only gateway-reachable client path is
Missions `POST /api/v1/store/purchase` (and `/store/exchange`), which then
calls Order server-to-server with a trusted `X-User-ID` header.

Further check found `Games-Labs-Missions/internal/handlers/mission/http/store.go`
`Exchange` handler (line 223) does not accept `coupon_code` at all — only
`CreatePurchase` (Purchase handler) threads `coupon_code` through to Order.
So exchange-side coupon apply is not actually wired end-to-end for mobile yet,
despite the Order doc listing `/api/v1/orders/exchange` as a coupon-accepting
apply surface.

## Scope

- Doc-only correction: `Games-Labs-Order/docs/coupon-public-contract.md` —
  clarify that APPLY must go through Missions' gateway-facing store endpoints,
  not directly at Order's own HTTP listener; flag that exchange-side coupon
  apply is not wired in Missions today.
- No code/behavior change.
- Produce a short "APIs to hand to the Mobile team" list (coupon + special
  item), delivered to operator in chat, not a new doc file (operator did not
  ask for one).

## Owner / path resolution

Meta/product-doc correction under Games-Labs-Order (product repo), not a
meta-tooling repo, so per root CLAUDE.md this needs an open TASK- run. Scope
is doc-only, single-repo, no contract/schema/behavior change, no migration,
no production-infra, no non-trivial rollback — stays lightweight (no
formal-run escalation per AGENTS.md tripwire).

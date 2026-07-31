# TASK-EAR-180 — Fix IDOR in Order ListOrders / ListMyRedemptionItems

## Type

bugfix

## Workstream

backend

## Priority

high

## Created

2026-07-31

## Epic

Player admin data-completion — P1b. Security debt paid down alongside
TASK-EAR-179 because P1 touches the same Order read-path family.

## Context

During TASK-EAR-137 (Purchase>Package history), a **live IDOR** was found in
Games-Labs-Order: `ListOrders` and `ListMyRedemptionItems` trust a
caller-supplied user id, so any authenticated caller can read another user's
orders / redemption items. It was surfaced, the operator deferred it, and the
close-out note says to flag it again whenever this code is touched — P1 is
that moment. Deferred long enough; this run closes it.

## Design constraints

- Follow the established Order identity convention (EAR-085 /
  coupon-from-package): **derive identity from the `X-User-ID` header set by
  the gateway, never from the request body/query** for user-scoped reads.
- Admin surfaces that legitimately read another user's data must go through
  admin-scoped endpoints/metadata (staff context), not the public
  user-scoped ones. Verify the Player Detail admin flows (EAR-137's package
  history) still work — they must not be collateral damage.
- **Test integrity rule**: the fix ships with regression tests that were seen
  failing before the fix — one proving cross-user access is now denied on
  each endpoint, one proving self-access still works, one covering the admin
  path.
- Error mapping: use `writeServiceError` so numeric codes survive
  (Order raw-HTTP MetaError trap).

## Scope

- Included: Games-Labs-Order `ListOrders` + `ListMyRedemptionItems` (and any
  sibling list endpoint found with the same pattern during the fix — sweep
  the handler file), regression tests, gateway metadata verification.
- Excluded: unrelated Order endpoints, schema changes, FE changes.

## Acceptance Criteria

- Cross-user read attempts on both endpoints return an authorization error on
  staging (verified live, both direct and through api-gateway).
- Self-reads and the admin Player Detail package-history flow still work on
  staging.
- Regression tests exist and were red before the fix (evidence in the run).
- A sweep note lists any other endpoints found with the same pattern
  (fixed here or explicitly deferred with reason).

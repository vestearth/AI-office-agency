# TASK-EAR-105: Integrate Coupon into Website and Mobile checkout

Parent `TASK-EAR-101`; blocked by `TASK-EAR-103`. Feature/general/high; `dev-2`.

Integrate the authenticated public coupon validate/apply contract into the actual Website and Mobile checkout owners identified during execution. Display authoritative server preview, send coupon through canonical order creation, handle every stable business error, and show applied coupon/discount/reward in order history. Do not call Admin APIs or calculate authoritative discounts client-side.

Scope must be narrowed to the current client repositories before edits; if a Website/Mobile client repo is absent, deliver verified API contract examples and record that external client implementation is waiting for its owner. No unrelated UI redesign.

## Scope decision — operator 2026-07-14

No Website/Mobile checkout repository exists under this workspace root (only
backend services, `Games-Labs-backoffice`, and `casperacc`, a separate
product). TASK-EAR-105 is scoped to backend/API-only: publish contract examples
and integration tests for the authenticated public validate/apply flow through
api-gateway.

## Scope clarification — operator 2026-07-14 (final)

The Website/Mobile client integration is **explicitly NOT our work** and is
**not a pending/deferred item on this task**. Our deliverable is only: (1) the
coupon configuration surface in `Games-Labs-backoffice` (TASK-EAR-104) and (2)
the backend/public API the client pulls the synced values from, with a
published contract for handoff (TASK-EAR-105 — `docs/coupon-public-contract.md`
+ contract tests). The dev team takes the client checkout integration forward
themselves against that published contract. Do NOT reopen/amend this task for
client UI; that is a separate dev-team-owned effort.

Acceptance (backend/API-only scope — this is the FULL acceptance for us, not a
partial pass): valid and invalid flows exercised through api-gateway;
authoritative preview documented; duplicate submit/payment retry/failure
recovery covered by contract tests; stable error codes documented with
examples; permission separation verified (no Admin API exposure). The published
contract doc is the client-team handoff artifact.


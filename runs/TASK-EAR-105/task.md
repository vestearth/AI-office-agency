# TASK-EAR-105: Integrate Coupon into Website and Mobile checkout

Parent `TASK-EAR-101`; blocked by `TASK-EAR-103`. Feature/general/high; `dev-2`.

Integrate the authenticated public coupon validate/apply contract into the actual Website and Mobile checkout owners identified during execution. Display authoritative server preview, send coupon through canonical order creation, handle every stable business error, and show applied coupon/discount/reward in order history. Do not call Admin APIs or calculate authoritative discounts client-side.

Scope must be narrowed to the current client repositories before edits; if a Website/Mobile client repo is absent, deliver verified API contract examples and record that external client implementation is waiting for its owner. No unrelated UI redesign.

## Scope decision — operator 2026-07-14

No Website/Mobile checkout repository exists under this workspace root (only
backend services, `Games-Labs-backoffice`, and `casperacc`, a separate
product). TASK-EAR-105 is scoped to backend/API-only for this pass: publish
contract examples and integration tests for the authenticated public
validate/apply flow through api-gateway. No client UI work happens under this
task ID until the operator supplies or confirms the actual Website/Mobile
checkout repo name(s); amend this task then.

Acceptance (backend/API-only scope): valid and invalid flows exercised through
api-gateway; authoritative preview documented; duplicate submit/payment
retry/failure recovery covered by contract tests; stable error codes
documented with examples; permission separation verified (no Admin API
exposure). Original full acceptance (client tests/build, order/history
display) applies once a client repo is identified and this task is amended.


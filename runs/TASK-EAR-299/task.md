# TASK-EAR-299 — Publish and verify the coupon checkout HTTP contract

## Type / workstream / priority

Feature / backend / high

## Parent / epic

- Parent: TASK-EAR-295
- Epic: Coupon-aware Stripe checkout

## Goal

Adopt the merged payment contract in API Gateway and prove that the existing
HTTP route transports `coupon_code` and `order_id` without exposing Order's
internal lifecycle RPCs.

## Scope

- Repository: `api-gateway` only.
- Depends on TASK-EAR-298 so Gateway verification targets the final Wallet
  behavior rather than a partial contract.
- Bump `shared-lib` to `v0.0.0-20260824045720-a2181ce77371`; update `go.mod` and
  `go.sum` together with no `replace` directive.

## Acceptance criteria

1. Existing `POST /api/v1/transaction` accepts optional `coupon_code` and
   preserves authenticated caller metadata and idempotency headers.
2. Create and status JSON responses expose additive `order_id`; omitted fields
   from old Wallet responses remain tolerated during rollout.
3. Generated/shared Swagger served by Gateway documents the new fields and
   stable payment/fulfillment status meanings.
4. No HTTP route exists for `PrepareCheckoutOrder`, `ConfirmCheckoutOrder`, or
   `FailCheckoutOrder`.
5. Route-level tests pass a coupon request through a stub Payment service and
   assert `order_id` serialization on create/status responses.
6. `GOWORK=off go test ./...`, `GOWORK=off go build -mod=readonly ./...`,
   dependency guard, and `git diff --check` pass and are recorded as evidence.

## Likely affected files

- `api-gateway/go.mod`
- `api-gateway/go.sum`
- `api-gateway/gateway/grpc.go` only if registration evidence requires a change
- `api-gateway/gateway/docs/docs.go` only if the existing shared Swagger loader
  does not automatically adopt the new descriptor
- focused Gateway route/contract `_test.go` files

## Risks and mitigations

- A dependency-only bump can compile while HTTP JSON behavior drifts. Require a
  route-level serialization test rather than relying on build success.
- Order's internal RPCs are intentionally unannotated. Add a negative route
  assertion so a future generated change cannot expose them accidentally.

## Out of scope

- Order/Wallet behavior, deployment, production, or Android edits.


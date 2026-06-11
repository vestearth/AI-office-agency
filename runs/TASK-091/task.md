# TASK-091: Persist Gift Redemption Item Total Quota

## Short name
`redemption-gift-total-quota`

## Type
feature

## Priority
high

## Parent / Epic
- Parent: `TASK-080`
- Related: `TASK-090`
- Epic: Admin Redemption Management

## Status

Pending. This task owns the remaining backend part of TASK-080/B6: manual
`total_quota` persistence for Gift redemption items.

Backend has already partially closed B6:

- `CreateRedemptionItemRequest` and `UpdateRedemptionItemRequest` already include
  `type_items` (`"e-voucher"` / `"gift"`).
- `orderpb.RedemptionItem` already returns `type_items`, `quota_used`,
  `total_quota`, and `total_redeemed`.
- `Games-Labs-Order` already stores `type_items` and derives E-Voucher
  `total_quota` from uploaded/imported codes.

Remaining gap: `total_quota` is not accepted in create/update requests, and Gift
items are forced to `total_quota = 0`. The Backoffice Gift create/edit UI has a
manual Total Quota input, but it cannot persist until this backend contract lands.

## PM Contract

```yaml
task:
  id: TASK-091
  title: Persist Gift Redemption Item Total Quota
  short_name: redemption-gift-total-quota
  parent: TASK-080
  related:
    - TASK-090
  epic: Admin Redemption Management
  type: feature
  priority: high
  created_at: '2026-06-11'
```

## Scope

### Target services

| Service | Reason |
| --- | --- |
| `shared-lib` | Add `total_quota` to the admin order create/update redemption item request contracts and regenerate proto/gateway/swagger artifacts. |
| `Games-Labs-Order` | Accept, validate, and persist Gift manual total quota while preserving derived E-Voucher quota behavior. |
| `api-gateway` | Bump/use the published shared-lib version so HTTP JSON accepts the new request field. |
| `ai-dev-office` | Store task status and handoff artifacts. |

### Affected files

| Path | Action | Description |
| --- | --- | --- |
| `shared-lib/proto/admin/adminorderpb/adminorder.proto` | modify | Add `int64 total_quota` to `CreateRedemptionItemRequest` and `UpdateRedemptionItemRequest` using new field numbers. |
| `shared-lib/proto/admin/adminorderpb/*` | modify | Regenerate protobuf, grpc-gateway, and swagger artifacts. |
| `Games-Labs-Order/internal/models/redemption.go` | modify | Add `TotalQuota` to `CreateRedemptionItemRequest`; update inherited update request shape. |
| `Games-Labs-Order/internal/core/handlers/adminorderhdl/adminorderhdl.go` | modify | Map `req.GetTotalQuota()` into the model for create/update. |
| `Games-Labs-Order/internal/core/services/ordersvc/service.go` | modify | Validate/normalize `total_quota` for Gift; preserve E-Voucher behavior. |
| `Games-Labs-Order/internal/core/repositories/redemption.go` | modify | Persist manual Gift `total_quota` on create/update; keep E-Voucher derived from code count. |
| `Games-Labs-Order/internal/core/services/ordersvc/service_test.go` | modify | Add focused coverage for Gift manual quota and E-Voucher derived quota behavior. |
| `Games-Labs-Order/internal/core/repositories/*_test.go` | modify if present | Add repository coverage if the current test structure supports it. |
| `Games-Labs-Order/go.mod` / `go.sum` | modify | Bump shared-lib after publish; no local `replace`. |
| `api-gateway/go.mod` / `go.sum` | modify | Bump shared-lib after publish; no local `replace`. |

### Out of scope

- Frontend wiring for `type_items`/`total_quota` already belongs to `TASK-090`.
- Delete redemption item endpoint.
- List filtering by `redemption_id` / `tag_id`.
- Total redeemed metrics.
- Multi-tier player quota.

## Public API / Contract

Add a request field to both admin order request messages:

```proto
message CreateRedemptionItemRequest {
  ...
  string type_items = 23; // e-voucher / gift
  int64 total_quota = 24;
}

message UpdateRedemptionItemRequest {
  ...
  string type_items = 24; // e-voucher / gift
  int64 total_quota = 25;
}
```

Expected JSON field names through grpc-gateway:

- `totalQuota` for camelCase clients
- `total_quota` where snake_case JSON is accepted by the generated gateway

Behavior:

- For `type_items = "gift"`:
  - accept `total_quota >= 0`
  - persist the submitted value to `redemption_items.total_quota`
  - do not require `code[]`
- For `type_items = "e-voucher"`:
  - continue deriving `total_quota` from `redemption_item_codes`
  - ignore or reject submitted `total_quota`; choose one behavior and document it
  - keep existing code validation behavior

Recommendation: ignore submitted `total_quota` for E-Voucher and derive from
`code[]`, because current backend already treats E-Voucher quota as the number of
codes and this avoids client/server drift.

## Acceptance Criteria

- [ ] `shared-lib` defines `total_quota` on create/update redemption item request contracts and generated artifacts are updated.
- [ ] `Games-Labs-Order` model/handler/service/repository accept the new field.
- [ ] Creating a Gift with `total_quota = N` returns `redemption_item.total_quota = N`.
- [ ] Updating a Gift from `N` to `M` returns and persists `redemption_item.total_quota = M`.
- [ ] Creating/updating an E-Voucher still returns `total_quota = len(code[])`.
- [ ] Gift create/update does not require `code[]`.
- [ ] Negative `total_quota` is rejected or normalized consistently; preferred behavior is reject with a structured invalid-request error.
- [ ] `api-gateway` builds with the bumped shared-lib and accepts the new JSON field.
- [ ] No committed `go.mod` contains `replace github.com/SparqLab/shared-lib => ../shared-lib`.

## Plan

### Approach

Implement sequentially. Start with the `shared-lib` proto contract and generated
artifacts. After `shared-lib` is published, bump `Games-Labs-Order` and
`api-gateway`, then implement service/repository behavior and focused tests.

Per AGENTS.md, do not implement downstream service changes against an unpublished
local replacement contract. Stop and ask the user to publish/bump shared-lib if
needed.

### Subtasks

| Order | ID | Agent | Description | Owned files | Parallel safe |
| --- | --- | --- | --- | --- | --- |
| 1 | `shared-lib-total-quota-contract` | `dev-2` | Add `total_quota` request fields to admin order proto and regenerate artifacts. | `shared-lib/proto/admin/adminorderpb/*` | false |
| 2 | `order-gift-quota-persistence` | `dev-2` | Bump shared-lib in Order; map, validate, and persist Gift `total_quota`; preserve E-Voucher derived quota. | `Games-Labs-Order/internal/**`, `Games-Labs-Order/go.mod`, `Games-Labs-Order/go.sum` | false |
| 3 | `gateway-shared-lib-bump` | `dev-2` | Bump shared-lib in api-gateway and verify generated route accepts the new field. | `api-gateway/go.mod`, `api-gateway/go.sum` | false |
| 4 | `verification-handoff` | `dev-2` | Run focused verification and document the resulting contract for frontend use. | `ai-dev-office/runs/TASK-091/*` | false |

## Assignment

- Primary: `dev-2`
- Parallel: `false`

Reason: This is cross-service contract work. It touches `shared-lib` proto and
generated files first, then downstream consumer `go.mod/go.sum` files. Running
parallel agents here would create avoidable merge and dependency risk.

## Verification

- `cd shared-lib && make proto` or the repo's existing proto generation command.
- `cd Games-Labs-Order && go test ./internal/core/services/ordersvc`
- `cd Games-Labs-Order && go test ./internal/core/repositories` if repository tests exist.
- `cd Games-Labs-Order && GOWORK=off go build -mod=readonly ./...`
- `cd api-gateway && GOWORK=off go build -mod=readonly ./...`
- Manual smoke through gateway after deploy:
  - create Gift with `totalQuota: 123`
  - get item by id and confirm `totalQuota: 123`
  - update Gift to `totalQuota: 456`
  - get item by id and confirm `totalQuota: 456`
  - create E-Voucher with two codes and confirm `totalQuota: 2`

## Context Sources

```yaml
context_sources:
  socraticode:
    status: used
    queries:
      - codebase_status projectPath=d:\\llm
  verified_source:
    - ai-dev-office/runs/TASK-080/task.md
    - ai-dev-office/runs/TASK-090/task.md
    - shared-lib/proto/admin/adminorderpb/adminorder.proto
    - shared-lib/proto/orderpb/order.proto
    - Games-Labs-Order/internal/models/redemption.go
    - Games-Labs-Order/internal/core/handlers/adminorderhdl/adminorderhdl.go
    - Games-Labs-Order/internal/core/repositories/redemption.go
  notes: >
    TASK-080 B6 is stale in part: type_items and response total_quota already
    exist. TASK-091 owns only the remaining backend request/persistence work for
    manual Gift total_quota.
```

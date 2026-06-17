# TASK-EAR-002: Add AdminWallet Rate Catalog Contract to shared-lib

## Short name
`adminwallet-rate-catalog-contract`

## Type
feature

## Priority
high

## Parent / Epic
- Parent: `TASK-EAR-001`
- Epic: Admin Store Exchange Management

## Status
Ready for implementation.

## Background

Wallet already has direct HTTP handlers for rate catalog list/get/upsert/deactivate,
but `AdminWalletService` in `shared-lib` currently exposes only wallet balance
admin RPCs. Backoffice should not sync production admin data by calling Wallet
direct HTTP paths. The missing piece is an AdminWallet gRPC/admin HTTP contract
owned by `shared-lib`.

## Scope

### Target services

| Service | Role |
| --- | --- |
| `shared-lib` | Add AdminWallet rate catalog messages/RPCs and regenerate proto artifacts. |

### Affected files

| File | Action | Notes |
| --- | --- | --- |
| `shared-lib/proto/admin/adminwalletpb/adminwallet.proto` | modify | Add rate catalog RPCs/messages with grpc-gateway annotations. |
| `shared-lib/proto/admin/adminwalletpb/*.pb.go` | modify/generated | Regenerate protobuf/go artifacts. |
| `shared-lib/proto/admin/adminwalletpb/*.pb.gw.go` | modify/generated | Regenerate grpc-gateway artifacts. |
| `shared-lib/proto/admin/adminwalletpb/*swagger*` | modify/generated | Regenerate swagger/openapi artifacts when existing generator supports it. |
| `shared-lib/go.mod` / `shared-lib/go.sum` | modify if needed | No local replace directives. |

## Required contract

Add these AdminWallet RPCs:

| RPC | HTTP mapping | Purpose |
| --- | --- | --- |
| `ListRateCatalog` | `GET /api/v1/admin/wallet/rate-catalog` | List active/versioned admin rates, filterable by `domain`. |
| `GetRateCatalog` | `GET /api/v1/admin/wallet/rate-catalog/{rate_key}` | Fetch a rate by stable key. |
| `UpsertRateCatalog` | `POST /api/v1/admin/wallet/rate-catalog` | Create/update the active version of a rate. |
| `DeactivateRateCatalog` | `POST /api/v1/admin/wallet/rate-catalog/{rate_key}/deactivate` | Deactivate a rate without hard delete. |

Minimum fields:
- `rate_key`
- `domain`
- `input_unit`
- `output_unit`
- `numerator`
- `denominator`
- `rounding_mode`
- `min_value`
- `max_value`
- `active_from`
- `active_to`
- `version`
- `is_active`
- `updated_by`
- `created_at`
- `updated_at`

For Store Exchange, callers will use:
- `rate_key = exchange.<order_package.code_name>`
- `domain = exchange`
- `input_unit = DIAMOND`
- `output_unit = COIN`
- `numerator = reward_coins`
- `denominator = price_diamonds`
- `rounding_mode = floor`

## Acceptance criteria

- [ ] `adminwallet.proto` includes the new RPCs, HTTP mappings, and request/response messages.
- [ ] Generated Go, gRPC, grpc-gateway, and swagger artifacts are updated by the repo's proto workflow.
- [ ] The contract remains additive and backward compatible.
- [ ] `shared-lib` builds/tests pass using the repo's standard command.
- [ ] No consumer service changes are made in this task.
- [ ] No local `replace` directive is committed.
- [ ] `ruby ai-dev-office/validate-yaml.rb TASK-EAR-002` passes.

## Out of scope

- Implementing Wallet handlers.
- Bumping `shared-lib` in downstream services.
- Backoffice UI integration.

## Assignment

- Primary: `dev-2`
- Parallel: `false`

Reason: this task owns shared contract files and generated artifacts, which must
not be edited in parallel with downstream service work.

## Next action

Run `./ai-dev-office/run-agent.sh TASK-EAR-002 dev-2`.

After this task is merged/published, the user must publish/bump `shared-lib`
before downstream tasks proceed.

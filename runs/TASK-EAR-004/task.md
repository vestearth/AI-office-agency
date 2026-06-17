# TASK-EAR-004: Expose AdminWallet Rate Catalog Through api-gateway

## Short name
`gateway-adminwallet-rate-catalog`

## Type
feature

## Priority
high

## Parent / Epic
- Parent: `TASK-EAR-001`
- Epic: Admin Store Exchange Management

## Status
Blocked until `TASK-EAR-002` is published and `api-gateway` bumps
`github.com/SparqLab/shared-lib` to the new version.

## Background

`api-gateway` already registers `adminwalletpb.RegisterAdminWalletServiceHandlerFromEndpoint`
against `WALLET_API_URL`. Once `shared-lib` includes the new AdminWallet rate
catalog HTTP annotations, gateway should expose the routes through the existing
authenticated `/api/*` grpc-gateway catch-all.

This task verifies the new routes are actually available through gateway, updates
docs/Postman if needed, and ensures admin auth/RBAC behavior stays aligned with
other admin APIs.

## Scope

### Target services

| Service | Role |
| --- | --- |
| `api-gateway` | Bump shared-lib, verify AdminWallet route exposure, update API docs/Postman. |

### Affected files

| File | Action | Notes |
| --- | --- | --- |
| `api-gateway/go.mod` / `api-gateway/go.sum` | modify | Bump published `shared-lib`; run `go mod tidy`; no local replace. |
| `api-gateway/gateway/grpc.go` | inspect/modify only if needed | AdminWallet is already registered; keep duplication out. |
| `api-gateway/docs/Games-Labs-APIs.postman_collection.json` | modify | Add admin Wallet rate catalog examples. |
| `api-gateway/gateway/docs/*` | modify/generated if applicable | Refresh swagger aggregation if the repo workflow requires it. |

## Expected gateway paths

- `GET /api/v1/admin/wallet/rate-catalog?domain=exchange`
- `GET /api/v1/admin/wallet/rate-catalog/{rate_key}`
- `POST /api/v1/admin/wallet/rate-catalog`
- `POST /api/v1/admin/wallet/rate-catalog/{rate_key}/deactivate`

All routes must remain behind existing gateway auth/admin middleware.

## Acceptance criteria

- [ ] Gateway builds against the published `shared-lib` version from `TASK-EAR-002`.
- [ ] The AdminWallet rate catalog routes are exposed via existing `/api/*` routing.
- [ ] Postman/API docs include list/get/upsert/deactivate examples for exchange rates.
- [ ] Manual curl or local route test demonstrates that gateway forwards the route to Wallet when `WALLET_API_URL` is configured.
- [ ] `GOWORK=off go test ./...` passes in `api-gateway`.
- [ ] `GOWORK=off go build -mod=readonly ./...` passes in `api-gateway`.
- [ ] `go.mod` and `go.sum` are committed together after `go mod tidy`.
- [ ] No `replace github.com/SparqLab/shared-lib => ../shared-lib` is committed.
- [ ] `ruby ai-dev-office/validate-yaml.rb TASK-EAR-004` passes.

## Out of scope

- Implementing Wallet handlers.
- Backoffice UI changes.
- Adding direct Gin proxy routes to Wallet rate catalog unless grpc-gateway
  exposure is proven impossible.

## Assignment

- Primary: `dev`
- Parallel: `false`

Reason: focused gateway/docs task after shared-lib publication.

## Next action

After `TASK-EAR-002` is published and gateway bumps `shared-lib`, run:
`./ai-dev-office/run-agent.sh TASK-EAR-004 dev`.

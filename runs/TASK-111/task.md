# TASK-111: Fix staging store exchange 500 and ECS rate-catalog env drift

## Short name
`missions-store-exchange-staging-500`

## Type
bugfix

## Priority
high

## Parent / Epic
- Epic: Games Labs staging mobile API reliability

## Status

PM planned. Ready for `dev-2` implementation.

## Request

Mobile/QA reported that the Store Exchange function is not working on the
staging mobile app, which calls the ECS staging API. API tests against
`/api/v1/store/exchange` return HTTP 500.

Initial source review found no intended mobile request-contract change. Mobile
should still call `POST /api/v1/store/exchange` with:

- `user_id`
- `rate_id`
- optional `idempotency_key`, or header `Idempotency-Key`

The backend should preserve client-safe error statuses instead of converting
downstream Order/Wallet failures into generic HTTP 500.

## Initial Evidence

- `api-gateway/gateway/grpc.go` registers Missions gRPC on `MISSION_API_URL`.
- `shared-lib/proto/missionspb/missions.proto` maps `StoreExchange` to
  `POST /api/v1/store/exchange`.
- `Games-Labs-Missions/internal/handlers/mission/http/store.go` decodes
  `user_id`, `rate_id`, and `idempotency_key`.
- `Games-Labs-Missions/internal/services/store_service.go` uses Order catalog
  when `USE_ORDERS_CATALOG=true`; it forwards `rate_id` as the Order
  `package_id` to `CreateExchangeOrder`.
- `Games-Labs-Missions/internal/clients/order/client.go` wraps non-2xx Order
  responses as plain `fmt.Errorf("order service error: ...")`. Because this is
  not a shared-lib meta error, Missions HTTP error mapping can surface it as
  HTTP 500.
- `Games-Labs-Missions/.github/workflows/staging.yml` exports
  `USE_ORDERS_CATALOG=true` but does not export `USE_WALLET_RATE_CATALOG=true`.
- `Games-Labs-Missions/ecs/env.names` includes `USE_ORDERS_CATALOG` but not
  `USE_WALLET_RATE_CATALOG`, while `k3s/deployment.yaml` includes both.

## Initial Verification

- Public staging health:
  `curl -sS -i --max-time 15 https://api-test-gateway.gameslabs.app/health`
  returned HTTP 200.
- Public `/api/v1/store/rates` and `/api/v1/store/exchange` without token return
  HTTP 401, so the gateway route exists and is auth-gated before service logic.
- `GOWORK=off GOCACHE=/private/tmp/codex-go-cache-missions-exchange go test ./internal/services ./internal/handlers/mission/http ./internal/clients/order`
  passed in `Games-Labs-Missions`.
- `GOWORK=off GOCACHE=/private/tmp/codex-go-cache-order-exchange go test ./internal/core/services/ordersvc ./internal/core/handlers/orderhdl`
  passed in `Games-Labs-Order`.
- Live CloudWatch inspection was not possible in this Codex session because
  `aws` CLI is not installed locally.

## Goal

Plan and implement the smallest backend/staging fix so mobile does not need a
contract change, `/api/v1/store/exchange` returns the correct client-safe error
status/body for downstream failures, and ECS staging carries the intended
Wallet rate-catalog configuration.

## Scope

### Target Services

| Service | Reason |
| --- | --- |
| `Games-Labs-Missions` | Owns `/api/v1/store/exchange`, Order client bridge, and ECS staging env render. |
| `Games-Labs-Order` | Downstream exchange order service; verify behavior and tests, but avoid changes unless root cause requires it. |
| `api-gateway` | Route owner for public client traffic; verify no gateway contract change is needed. |
| `shared-lib` | Error/status contract source; do not change unless PM confirms a shared error-contract update is required. |

### Likely Affected Files

| Path | Action | Description |
| --- | --- | --- |
| `Games-Labs-Missions/internal/clients/order/client.go` | modify | Preserve downstream Order status/error payload or map known responses to shared-lib meta errors instead of generic 500. |
| `Games-Labs-Missions/internal/services/store_service.go` | modify | Add/adjust tests or error handling around Order catalog exchange path if needed. |
| `Games-Labs-Missions/internal/handlers/mission/http/store.go` | modify | Add focused handler coverage proving non-500 client-safe exchange errors if needed. |
| `Games-Labs-Missions/.github/workflows/staging.yml` | modify | Export `USE_WALLET_RATE_CATALOG=true` for ECS staging if confirmed. |
| `Games-Labs-Missions/ecs/env.names` | modify | Include `USE_WALLET_RATE_CATALOG` in ECS rendered environment. |

### Explicitly Excluded

- No mobile request/response contract change unless fresh evidence proves one is required.
- No `shared-lib` publish/bump unless PM confirms a shared error contract is necessary.
- No broad exchange redesign, package schema migration, or Backoffice UX changes.

## Acceptance Criteria

- [ ] `POST /api/v1/store/exchange` keeps the existing mobile request contract:
  `user_id`, `rate_id`, and optional `idempotency_key` or `Idempotency-Key`.
- [ ] Missions no longer converts known non-2xx Order exchange responses into
  generic HTTP 500. Package-not-found/invalid-package style responses must become
  a client-safe 4xx, Order unavailable must become 503, and unknown unexpected
  failures may remain 500.
- [ ] Focused tests prove the Order client and/or Store handler return
  non-500 statuses for at least one downstream Order non-2xx response.
- [ ] ECS staging for `Games-Labs-Missions` renders `USE_WALLET_RATE_CATALOG=true`
  in addition to `USE_ORDERS_CATALOG=true`.
- [ ] `Games-Labs-Missions` focused tests pass with `GOWORK=off` and a writable
  `GOCACHE`.
- [ ] `Games-Labs-Order` exchange service tests still pass, or are documented as
  unchanged if no Order files are touched.
- [ ] The final handoff to mobile says no mobile-side contract change is needed,
  and asks them to use fresh `rate_id` values from `GET /api/v1/store/rates`.

## Implementation Plan

1. Inspect the current Order exchange HTTP error responses and shared-lib error
   mapping before editing.
2. Add focused failing coverage in `Games-Labs-Missions` for the current
   downstream-error-to-500 behavior.
3. Fix the smallest layer that preserves client-safe status. Prefer mapping in
   `internal/clients/order/client.go` or a narrow typed error over changing the
   mobile-facing contract.
4. Add `USE_WALLET_RATE_CATALOG=true` to the ECS staging render path:
   `.github/workflows/staging.yml` and `ecs/env.names`.
5. Re-run targeted Missions tests and Order exchange tests.
6. Prepare a short mobile/QA handoff with request shape, expected error
   behavior, and retest steps.

## Risks

- Order currently returns plain HTTP errors in the exchange HTTP handler; mapping
  exact business codes may require parsing JSON or status text. Keep the first
  fix narrow and avoid a shared-lib contract change unless unavoidable.
- A token-authenticated staging reproduction is still needed to prove the exact
  runtime symptom after deploy. If logs are available, use CloudWatch request ID
  evidence before broadening scope.
- If mobile is using stale hardcoded `rate_id` values, backend error mapping will
  improve the response but mobile must still refresh from `GET /api/v1/store/rates`.

## Verification

- `cd Games-Labs-Missions && GOWORK=off GOCACHE=/private/tmp/codex-go-cache-missions-exchange go test ./internal/services ./internal/handlers/mission/http ./internal/clients/order`
- `cd Games-Labs-Order && GOWORK=off GOCACHE=/private/tmp/codex-go-cache-order-exchange go test ./internal/core/services/ordersvc ./internal/core/handlers/orderhdl`
- `ruby ai-dev-office/validate-yaml.rb TASK-111`
- Optional staging smoke after deploy with a valid user token:
  `GET /api/v1/store/rates`, then `POST /api/v1/store/exchange` using a fresh
  `rate_id`.

## Assignment

- Primary: `dev-2`
- Parallel: `false`

Reason: the work crosses backend error mapping and ECS staging env, but the
files are tightly coupled enough that one sequential owner is safer than
parallel lanes.

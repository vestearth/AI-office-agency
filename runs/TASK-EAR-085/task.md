# TASK-EAR-085: Order exchange endpoint trusts body.user_id (auth trust boundary)

## Short Name

`order-exchange-userid-trust-boundary`

## Type

security

## Priority

medium

## Status

Opened 2026-07-07 (Claude advisory lane). Spun off from the TASK-EAR-084 final
adversarial review (finding F11).

## Background

`Games-Labs-Order/internal/core/handlers/orderhdl/http.go` `CreateExchangeOrderHTTP`
reads `user_id` from the **request body** (`body.UserID`, ~L106/L115) and passes
it straight to `CreateExchangeOrder`. The EAR-084 service-layer tenant guard
(`existing.UserID != req.UserID` -> conflict) is therefore only as strong as the
caller-supplied `user_id`: a caller who can reach the endpoint and knows/guesses
another user's UUID plus an idempotency key could set `body.user_id` to the
owner and pass the guard, replaying the order back or triggering a
currency-moving failed-order recovery for that user.

### Scope of the real risk (why this is medium, not a live P1)

- **Pre-existing and Order-wide.** The whole Order HTTP API (purchase, exchange,
  etc.) trusts `body.user_id`; EAR-084 did not introduce it. EAR-084 only made
  the exchange replay path currency-moving, which raised the stakes.
- **Not exploitable in the deployed topology.** Order is an internal service
  (`ORDERS_API_URL=http://games-labs-order-service.games-labs.local:8087`),
  reached service-to-service by Missions. External mobile clients hit Missions
  (which derives the authenticated user from the JWT) — they cannot reach the
  Order HTTP API directly. So the forged-`user_id` path requires internal
  network access.
- **The codebase already has the right pattern.** A sibling handler in the same
  file reads `X-User-ID` / `userid` from the request header
  (`orderhdl/http.go:196`). The exchange endpoint simply does not use it.

## Goal

Make the Order exchange endpoint derive the caller identity from a trusted
header (as the sibling handlers do) instead of the request body, so the
service-layer tenant guard cannot be bypassed by a forged `body.user_id`.

## Scope (cross-repo — coordinated change)

| Service | Reason |
| --- | --- |
| `Games-Labs-Order` | `CreateExchangeOrderHTTP` (and, for consistency, other player-facing order endpoints that trust `body.user_id`) should read the user id from `X-User-ID` (fallback `userid`) header, mirroring the sibling handler; ignore/deprecate `body.user_id`. |
| `Games-Labs-Missions` | The Missions order client (`internal/clients/order/client.go`) currently sends `user_id` in the JSON body for `CreateCustomExchangeOrder` / `CreateExchangeOrder`. It must send the `X-User-ID` header (the authenticated user Missions already knows) so the shipped EAR-083 flow keeps working. |
| `ai-dev-office` | Tracks this cross-repo change. |

## Constraints / risks

- **Touches the shipped EAR-083 contract** (Missions -> Order exchange call), so
  Order and Missions must change together and deploy together — do NOT change the
  Order side alone or the live custom-exchange flow breaks.
- Audit every player-facing Order endpoint that reads `body.user_id`; decide
  per-endpoint whether to switch to the header now or in a follow-up. Keep the
  change consistent with existing `X-User-ID` handlers.
- Consider whether any admin/internal caller relies on `body.user_id` before
  removing it.

## Acceptance criteria

- The Order exchange endpoint derives the user id from `X-User-ID` (fallback
  `userid`) header; a request whose header identity differs from an existing
  order's owner cannot replay or recover it (returns the neutral conflict).
- Missions sends `X-User-ID` on its exchange order calls; the EAR-083 custom and
  tier exchange flows still work end-to-end.
- Handler/integration test: a forged `body.user_id` set to the order owner while
  the authenticated header principal differs returns a neutral conflict and
  performs no wallet/settlement work.
- `go build ./...` + tests pass in both repos.

## Verification plan

- `ruby ai-dev-office/validate-yaml.rb TASK-EAR-085`
- Order handler test for forged-body / header-principal mismatch.
- Missions client test asserting `X-User-ID` is sent.
- Coordinate branch/deploy so Order + Missions land together (after EAR-084
  merges to avoid an ordersvc/service.go conflict).

# TASK-102: Game service must normalize forwarded asset URLs independent of gateway PUBLIC_BASE_URL

## Short name
`game-asset-url-normalize-forwarded`

## Type
bugfix (regression hardening)

## Priority
high

## Parent / Epic
- Parent: TASK-101 (`backoffice-game-asset-url-8080`)
- Epic: Backoffice Game Management

## Background

TASK-101 fixed IDG asset thumbnails rendering as
`http://api-test-gateway.gameslabs.app:8080/assets/...` by propagating the
public origin through the api-gateway (`PUBLIC_BASE_URL` -> `x-forwarded-host` /
`x-forwarded-proto` metadata), plus a Game-side rewrite of legacy absolute asset
URLs (commit `f89599d`).

On 2026-06-19 the CI was reworked (`disable Contabo auto-deploy on main; add ECS
staging/prod workflows`). The api-gateway `PUBLIC_BASE_URL` value is injected
into the live `api-gateway-config` ConfigMap only by the legacy `deploy.yml`
workflow (ArgoCD `ignoreDifferences` keeps it out of git-managed state). With
that workflow disabled, the value was lost, so the gateway again forwards the
internal request (`http` + container port `:8080`). The bug regressed on both
`/api/v1/game` and `/api/v1/admin/games`.

Verified live (2026-06-19):
```
"imageUrl":"http://api-test-gateway.gameslabs.app:8080/assets/idg-img/Abyssal%20Rite.png"
```

## Decision

The team may move the deploy again, so harden on the Games-Labs-Game side rather
than rely on the gateway env. `forwardedBaseURL` normalizes the forwarded value:
for public `gameslabs.app` hosts, drop any port and force `https`. This is
defense-in-depth; the gateway `PUBLIC_BASE_URL` remains the cleaner primary fix.

## Scope

- `internal/core/handlers/gamehdl/grpc.go` — `forwardedBaseURL`
- `internal/core/handlers/admingamehdl/grpc.go` — `forwardedBaseURL`
- `internal/core/handlers/webgamehdl/grpc.go` — `forwardedBaseURL`
- Tests reproducing the real (dirty) forwarded metadata.

## Acceptance criteria

- Given `x-forwarded-proto=http` and `x-forwarded-host=api-test-gateway.gameslabs.app:8080`,
  asset image URLs resolve to `https://api-test-gateway.gameslabs.app/assets/...`.
- Existing clean-metadata behavior unchanged.
- Non-gameslabs.app / localhost hosts unchanged (dev unaffected).
- `go test ./...` green.

## Notes

Claude advisory lane (manual). Deployment of the change is out of scope here and
handled separately; this run covers the code change only.

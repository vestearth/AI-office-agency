# TASK-001: Refactor Asset Proxy Initialization

## Overview
Refactor the game asset proxy to use a dedicated `GameHTTPURL()` config function
and a reusable `NewSingleHostProxy()` helper, replacing the inline URL construction
that was previously hardcoded inside `gateway/http.go`.

## Type
refactor

## Priority
medium

## Target Service
api-gateway

## Target Files
- `config/config.go`
- `gateway/http.go`
- `gateway/proxy.go`
- `services/clients.go`

## Description
Previously, the asset proxy URL was derived from `GAME_API_URL` by swapping the gRPC
port (50053) to HTTP port (8083) inside `http.go`. This logic was not reusable and
mixed URL construction into the HTTP router initialization.

The refactor:
1. Moves URL derivation to `config.GameHTTPURL()` which respects `GAME_HTTP_URL` env
   var first, then falls back to deriving from `GAME_API_URL` with port substitution.
2. Moves proxy construction to `gateway.NewSingleHostProxy()` for reuse.
3. Removes old `gameAssetURL`, `newAssetProxy`, `newAssetProxyForTarget` functions
   from `http.go`.
4. Updates `services/clients.go` to use `config.GameHTTPURL()`.

## Acceptance Criteria
- [ ] `GameHTTPURL()` returns `GAME_HTTP_URL` if set
- [ ] `GameHTTPURL()` falls back to deriving HTTP URL from `GAME_API_URL` with port 8083
- [ ] `GameHTTPURL()` handles missing scheme gracefully
- [ ] `NewSingleHostProxy()` returns error if target is empty or invalid URL
- [ ] `/assets/*filepath` route is registered only when `GameHTTPURL()` returns non-empty
- [ ] No dead code remains in `http.go`
- [ ] `services/clients.go` uses `config.GameHTTPURL()`

# TASK-EAR-330 — Commit the stale admin swagger regeneration drift in shared-lib

## Type

refactor (generated-artifact hygiene; `chore` in the shared-lib commit prefix)

## Workstream

backend

## Priority

medium

## Created

2026-09-07

## Parent / Epic

- Parent: none
- Epic: none
- Sequence: 1 of 1

## Goal

`proto/admin/admingamepb/swagger.pb.go` and
`proto/admin/adminuserpb/swagger.pb.go` in `shared-lib` are stale relative to
their `.proto` sources. Running `make buf` on a clean `main` regenerates them
with changes belonging to *earlier, already-merged* tasks, so every branch that
touches a proto inherits unrelated drift and has to revert it by hand.

Commit the regeneration once, on its own branch, so it stops resurfacing.

## Evidence

- `make buf` on a clean checkout of `main` (`608e403`) leaves exactly two files
  modified — `git status --short` shows nothing else.
- `adminuserpb/swagger.pb.go`: GetUser's `summary` still carries the OLD
  route-order comment. The proto was corrected in **TASK-EAR-319** (grpc-gateway
  v2's `ServeMux.Handle` *prepends*, so the LAST registered pattern wins and the
  `{user_id}` wildcard must be declared FIRST so the literal `/wallets` and
  `/summary` siblings win) but the generated swagger was never regenerated.
- `admingamepb/swagger.pb.go`: missing the `ListPlayerGameActivity` `offset`
  query parameter and the `total` response field from **TASK-EAR-293**
  (+13 lines).
- The drift has already forced a manual revert in **TASK-EAR-314** and in
  **TASK-EAR-329 gate 1**, in both cases to keep unrelated changes out of a
  contract PR.

## Scope

- Regeneration output only. **No `.proto` file is edited.**
- `shared-lib` only. No downstream service adopts anything — the change is
  documentation metadata inside the embedded swagger JSON string, with no Go
  API and no wire surface change.

## Acceptance criteria

1. Branch off `main`; `make buf` run; `git status --short` shows exactly the two
   `swagger.pb.go` files and nothing else.
2. No `.proto` file appears in the diff.
3. `GOWORK=off go build ./...` passes.
4. `GOWORK=off go test ./...` passes with no failures.
5. `buf breaking --against '.git#branch=main'` is clean.
6. PR opened against `main`. **shared-lib PRs are merged and published by the
   operator** — this run stops at the open PR.

## Non-goals

- Any `.proto` change, additive or otherwise.
- Any downstream `go.mod` bump — nothing needs to adopt this.
- Adding a CI check that fails on buf drift. Worth considering separately, but
  out of scope here.

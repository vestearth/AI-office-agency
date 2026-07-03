# TASK-EAR-065: Fix event mission gRPC bridge PathValue bug (Claim + Get)

## Short name

`event-bridge-pathvalue-fix`

## Type

bugfix

## Workstream

backend (Games-Labs-Missions)

## Created

2026-07-03

## Goal

Event mission by-id public RPCs fail through the api-gateway gRPC bridge:
`ClaimMissionEvent` and `GetMissionEvent` bridge methods use `s.call`
(`httpx.CallHandler`, bypasses the mux) while their HTTP handlers read
`r.PathValue("event_id")` → empty → 400 "event_id required". Same defect
class as EAR-046 (admin by-id handlers).

## Evidence (main@18adb2c)

- `internal/handlers/mission/http/event.go:69` (GetEvent) and `:96`
  (ClaimMissionEvent) read `r.PathValue("event_id")`.
- `internal/handlers/mission/grpc/server.go:58-65` (ClaimMissionEvent) and
  the GetMissionEvent method use `s.call`; the file has no `callPath` helper.
- The fix pattern exists in `internal/handlers/adminmission/grpc/server.go:36`
  (`callPath` → `httpx.CallHandlerWithPath`).

## Scope

- Branch `fix/TASK-EAR-065-event-bridge-pathvalue` from `main` in an isolated
  git worktree (feature branch TASK-EAR-064 is concurrently active in the
  primary working tree; it independently adds a `callPath` helper — trivial
  merge conflict expected and accepted).
- Add `callPath` helper to mission grpc server (mirror adminmission), switch
  ClaimMissionEvent + GetMissionEvent to it, regression tests for both.
- Out of scope: TASK-EAR-064 feature surface.

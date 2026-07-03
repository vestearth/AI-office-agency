# TASK-EAR-066: Fix event mission admin create 500

## Short name

`event-create-500-fix`

## Type

bugfix

## Workstream

backend (Games-Labs-Missions)

## Created

2026-07-03

## Goal

Admin "Create Event Mission" (`POST /api/v1/admin/missions/events`) returns 500
on the test gateway. Two backend defects, both fixed here.

## Root cause

1. **Functional:** the frontend create payload omits `event_id` (server was
   meant to assign it), but `validateEventRequest` required it on create and
   generated nothing → every create failed.
2. **Status mapping:** the event admin service wraps business errors with
   `fmt.Errorf("%w: ...", ErrInvalidInput)`. shared-lib `meta.IsError` uses a
   bare type assertion (no unwrap), so `HTTPStatusFromError` classified every
   wrapped validation failure as 500 instead of 400/404/409 — masking the real
   message. The event handler used bare `writeSvcError`; sibling handlers
   (`daily_plans.go`) already unwrap with `errors.Is`.

## Fix

- `internal/services/event_admin.go`: `generateEventID(title)` — slug from title
  + short random hex suffix (matches seeded id style, non-ASCII titles fall back
  to `event-…`). `validateEventRequest` now derives the id on create when
  omitted, still honoring an explicitly supplied id; title check moved ahead of
  id generation.
- `internal/handlers/adminmission/http/events.go`: `writeEventError` unwraps with
  `errors.Is` (ErrInvalidInput→400, ErrMissionEventNotFound→404,
  ErrMissionEventJoinClosed→409, else 500 fallback); all 6 admin event handlers
  use it instead of bare `writeSvcError`.

## Tests

- Service: create without event_id generates a title-slug id; explicit id
  honored; unique suffix; empty title still 400; non-ASCII title id valid.
- HTTP: wrapped ErrInvalidInput → 400, not-found → 404, success → 201.
- Both verified to fail pre-fix (the HTTP test reproduces the exact 500 the
  operator saw) and pass post-fix. Full `go build/vet/test ./...` green.

## Scope

Branch `fix/TASK-EAR-066-event-create-500` from `staging`. Backend only; no FE
change required (server now owns id assignment). Decision (backend generates
event_id) confirmed with operator 2026-07-03.

## Out of scope

- Fixing shared-lib `meta.IsError` to unwrap (broader blast radius; other
  services rely on current behavior). Handled locally at the handler instead.

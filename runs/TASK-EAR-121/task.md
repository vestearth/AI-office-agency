# TASK-EAR-121 — Event mission list "Min Value Required" always shows "-"

## Symptom
Operator screenshot of `admin/manage/missions?type=event` (On going tab):
every row's "Min Value Required" column shows `-`, regardless of condition
type (Game Turnover, Category Turnover, Any Game Turnover).

## Investigation
Operator shared their live staff bearer token + userId for read-only
diagnosis. Compared the two admin endpoints on staging:

- `GET /api/v1/admin/missions/events` (list, backs the table) →
  `"conditions":[]` on every item.
- `GET /api/v1/admin/missions/events/play-any-game-ddf3658a` (single-event
  detail, backs the edit page) →
  `"conditions":[{"type":"ANY_GAME_TURNOVER","params":{"min_turnover":50000,...}}]`.

Frontend `minValueLabel`/`readConditionParams` (Games-Labs-backoffice
`app/utils/eventMissionMap.ts`) were already correct and covered by
existing unit tests handling both snake_case and camelCase param shapes —
verified in the prior thumbnail investigation. The bug is backend-only.

## Root cause
`Games-Labs-Missions/internal/repositories/event_repo.go`
`ListMissionEventsAdmin` hydrates `Games` per event row (a per-event
`listEventGames` call) but never called `listEventConditions`, unlike
`GetMissionEventFull` (single-event detail) which hydrates both. So every
list row's `Conditions` field stayed empty end to end, and the frontend had
no data to render regardless of its own logic.

## Fix
Call `listEventConditions` per event in the same hydration loop as
`listEventGames`, mirroring the existing pattern.

## Scope
Single file (+ new sqlmock repo test), backend-only, no contract/proto
change — `Conditions` was already part of the response shape, just never
populated on this path.

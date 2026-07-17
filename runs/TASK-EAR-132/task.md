# TASK-EAR-132: Wire Grant Pass + Complete Mission panels to existing Missions admin APIs

## Type

feature

## Workstream

frontend

## Priority

high

## Created

2026-07-17

## Goal

Kill the two most dangerous fake-success panels on
`admin/manage/player/edit/[id]` (Games-Labs-backoffice): GrantPassPanel and
CompleteMissionPanel currently import `~/data/mock` and show
"activated/updated successfully" toasts without firing any request. The
backend endpoints already exist and are implemented in Games-Labs-Missions:

- `POST /api/v1/admin/store/give-pass` `{user_id, pass_type, days}` —
  `StoreService.GrantPass`; an active pass of the same type is extended
  (duration stacks onto current expiry).
- `POST /api/v1/admin/missions/force-complete` `{user_id, type, mission_id}`
  — supports `type=monthly` and `type=daily_mission` (mission_id required)
  ONLY; weekly/event force-complete does not exist backend-side and is out
  of scope.
- `GET /api/v1/admin/store/passes/config` — pass options for the panel
  (replaces mockGrantPassOptions).

One backend read is missing: an admin view of a player's current mission
progress + active passes (panels need real lists, and "Now Active /
remaining" display). Operator approved adding it (phase-2 sign-off,
2026-07-17).

## Scope

In:
- shared-lib (`adminmissionpb`): new RPC `GetUserMissionOverview`
  (typed request `{user_id}`, **google.protobuf.Struct response** —
  passthrough keeps snake_case for the Backoffice per the TASK-EAR-076
  camelCase lesson) bound to `GET /api/v1/admin/missions/user-overview`
  (query param `user_id`, no path wildcard → no route-order risk).
- Games-Labs-Missions: HTTP handler + route returning
  `{daily_missions (with per-user progress), monthly_challenge,
  active_passes}` reusing the same service getters the public
  daily/monthly/store endpoints use, keyed by explicit user_id; gRPC
  bridge method via `s.call` with query URL (GetCheckInConfig pattern —
  NOT r.PathValue, per the EAR-046 bridge trap). Hardening: add the same
  `isAdminRole` check `HandleForceComplete` has to `HandleGrantPass`
  (currently trusts the gateway blindly).
- api-gateway: shared-lib bump.
- Games-Labs-backoffice (worktree): GrantPassPanel + CompleteMissionPanel
  accept the player id, load real data (passes config + user overview),
  fire the real POSTs, success toast only on 200; remove mock imports.

Out:
- Weekly/event force-complete (no backend support).
- SendVoucherPanel (TASK-EAR-133), status/reset password (TASK-EAR-131),
  Detail page (TASK-EAR-134), ListUser filters (TASK-EAR-135).

## Acceptance criteria

- Grant Pass: selecting a pass + days fires POST give-pass; toast reflects
  the actual response; active pass state refreshes from user-overview.
- Complete Mission: lists the player's daily missions (+ monthly
  challenge) with progress from user-overview; completing fires
  force-complete with correct type/mission_id; unsupported types are not
  offered.
- `GET /api/v1/admin/missions/user-overview?user_id=` returns snake_case
  JSON through the gateway (Struct passthrough verified).
- `go build`/`go test` green in Missions; backoffice `npm run build`
  green; PRs opened (Missions/shared-lib/gateway → staging path, FE →
  main), links recorded here.

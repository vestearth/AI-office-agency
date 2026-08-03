# TASK-EAR-197 — Restore configured games in authenticated VIP detail

## Request

Fix the public VIP-level detail endpoint returning no configured games to a
normal authenticated player.

## Observed staging behavior

- In `GameLab_STG`, a fresh login as the QA player followed by
  `GET {{base_url}}/api/v1/vip-levels/1` returns HTTP `200` with
  `data.games: []`.
- The mobile VIP 1 screen consequently renders zero games.
- This is an authenticated runtime reproduction, not an inference from UI
  alone. Do not record player identifiers, access tokens, passwords, or other
  credentials in task outputs.
- Operator-supplied Backoffice evidence shows VIP1 with `Total Games: 22` and
  a populated group-edit card list. Its browser origin is `localhost:3000`, so
  this confirms configured membership in that Backoffice data context but does
  not by itself prove that the UI is calling the same staging data plane as the
  mobile request.

## Source evidence

- `Games-Labs-User/internal/core/services/usersvc/service.go` calls
  `GetLevelGamesByLevel` from `GetVipLevel` and discards any returned error,
  leaving the public detail response with an empty games list.
- `Games-Labs-User/internal/adapters/gameadt/adapter.go` forwards incoming
  player metadata into the Game service's `AdminGameService`
  `GetLevelGameGroupByLevel` RPC.
- `Games-Labs-Game/internal/core/handlers/admingamehdl/grpc.go` requires
  staff permission for that RPC.

The likely path is therefore: player metadata reaches a staff-only RPC, the
adapter returns an authorization error, and User converts it into a misleading
successful response with no games.

## Goal

For an authenticated normal player, return the Backoffice-configured games for
an active VIP level through `GET /api/v1/vip-levels/{level}`. If the User
service cannot fetch that configuration, make the failure observable instead
of returning a misleading `200` with an empty list.

## Scope

- Included:
  - `Games-Labs-User` service and focused tests.
  - A narrowly scoped trusted internal context for this public read's call to
    the existing Game admin RPC.
  - Explicit User-service error handling for failures from the Game adapter.
  - Staging QA of the public player endpoint; separately compare membership
    against the staff-only Game admin endpoint when staff credentials are
    supplied.
- Excluded:
  - `shared-lib`, protobuf, public HTTP-route, API-gateway, and
    `Games-Labs-Game` contract changes.
  - Database migrations, direct database edits, game-group data changes,
    replay/backfill, Postman collection saves, and production deployment.
  - Changing global metadata forwarding for unrelated User-to-Game calls.

## Constraints

- Preserve the existing public response contract for successful requests.
- Do not weaken the Game admin RPC's staff authorization; make only the
  service-to-service call trusted and narrowly scoped.
- Prefer extending existing focused tests; create a new test file only after
  checking the nearby test conventions.

## Acceptance criteria

1. A normal player's metadata no longer reaches the staff-gated Game RPC for
   this public VIP games read; unrelated adapter methods retain their current
   forwarding behavior.
2. An error retrieving configured VIP games is surfaced through the User
   service rather than silently producing a successful empty-games response.
3. Focused adapter/service tests cover the player-metadata regression and
   Game-adapter failure behavior; relevant User tests and a readonly Go build
   pass.
4. After a staging deployment, a fresh normal-player request has configured
   games when level 1 has configured membership. A staff-only comparator
   `GET /api/v1/admin/group/level-games/by-level/1` is recorded separately;
   first identify the Backoffice API target before treating its count of 22 as
   the staging expected count. If staff credentials or environment parity are
   unavailable, that portion stays explicitly unverified.

## Suggested ownership

Assign `dev-2` sequentially: auth metadata, a public API failure mode, and
cross-service behavior need adversarial review despite the narrow User-service
code scope.

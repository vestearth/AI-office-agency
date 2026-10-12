# TASK-EAR-387 — Typed mission event rows for the monitoring report

Parent: TASK-EAR-291. Owner: Games-Labs-Missions.

## Problem

`ListMissionEvents` exists at `GET /api/v1/admin/missions/events` and returns
`google.protobuf.Struct`. The Mission Event tab does not render it. The tab
stays empty because that payload was never verified as report rows.

## Outcome

The event tab lists the admin events as rows. A measure the event source does
not have stays absent on the row. The whole tab must not stay on the
unavailable message.

## Scope

- `Games-Labs-Missions` owns the event list and any report fields added to it.
- `shared-lib` replaces the free-form list response with a typed report row
  if the current Struct cannot be bound safely. Publish before the consumer bump.
- `api-gateway` follows the module bump.
- `Games-Labs-backoffice` binds `MissionEventTab`.

## Acceptance

- The event tab shows one row per admin event returned by the server.
- Players and completed counts are present only when Missions actually has them.
- The unavailable copy in `MissionEventTab.vue` is gone.
- An authenticated admin-dev read matches the API, including an empty list.

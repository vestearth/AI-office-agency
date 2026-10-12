# TASK-EAR-386 — Admin monthly mission board for the monitoring report

Parent: TASK-EAR-291. Owner: Games-Labs-Missions.

## Problem

The Mission Monthly tab on the monitoring report renders an empty table and
says Missions has no admin monthly endpoint. `monthly_challenges` is a
per-user record. It is not a board the report can list.

## Outcome

An admin read returns monthly rows for a selected range. The Backoffice tab
renders those rows and no longer shows the unavailable message. An empty
range is an empty table, not that message.

## Scope

- `Games-Labs-Missions` publishes the read.
- `shared-lib` holds the contract if a new RPC is required. Publish it before
  the consumer bump. No `replace` directive.
- `api-gateway` picks up the generated route when the module is bumped.
- `Games-Labs-backoffice` binds `MissionMonthlyTab`.

## Acceptance

- The monthly tab shows server rows, or an empty table when the range has none.
- The unavailable copy in `MissionMonthlyTab.vue` is gone.
- Measures the source cannot produce are absent, not zero.
- An authenticated admin-dev read of the monthly tab matches the API.

# TASK-EAR-291 — Connect Monitoring Report pages

## Type

feature

## Workstream

frontend

## Goal

Replace Monitoring report mocks with aggregate/report drill-down APIs and implement the Mission report with real data.

## Scope

- `Games-Labs-backoffice` only.
- Player, game, provider, package, mission, special item, promotion, and redemption report routes.

## Acceptance criteria

1. Reports use server-side aggregate data with correct date/search/filter/paging behavior.
2. Drill-down routes use canonical entity IDs and handle missing/partial data.
3. Mission report no longer renders a permanent empty shell.
4. No mock report arrays remain in monitoring report routes.

## Dependencies

Blocked on TASK-EAR-286 and the source event tasks TASK-EAR-287, TASK-EAR-288,
TASK-EAR-289 (Game) and TASK-EAR-301 (Missions).

# TASK-EAR-290 — Connect Monitoring Player Log pages

## Type

feature

## Workstream

frontend

## Goal

Replace the eight Monitoring Player Log mock datasets with the new paginated Monitoring APIs.

## Scope

- `Games-Labs-backoffice` only.
- Account, VIP, gameplay, wallet, store, mission, free-coin, and redemption pages.

## Acceptance criteria

1. All eight pages use server filters, pagination, totals, and sort semantics.
2. Loading, empty, error, and partial-data states are visible and honest.
3. No fabricated zero values or mock activity remains in these pages.
4. Focused frontend tests and build pass.

## Dependencies

Blocked on TASK-EAR-286 and the source event tasks TASK-EAR-287, TASK-EAR-288,
TASK-EAR-289 (Game) and TASK-EAR-301 (Missions).

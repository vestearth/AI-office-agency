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

## Mission Weekly Report metric definition (operator, 2026-09-30)

`Completed / Participants` counts **distinct people**, not mission rows or
participation instances. For a weekly plan, Participants are distinct players
with progress or a claim on any activity in that plan. Completed are distinct
participants who completed every activity in that plan. For the header across
the selected report range, count each participant once even when they joined
multiple weekly plans, and count each completed player once when they finished
at least one of those plans. The numerator is a subset of the denominator.

Compute these counts in Missions over the full filtered set, not by adding
per-mission Logs counts or paging through plan-player rows in Backoffice.
The existing plan-player read exposes a plan-level participant total but no
completed total or range-level distinct counts. Reward and bonus claimed
amounts also need plan attribution and currency-aware aggregation before the
header can show verified totals. A cross-repo implementation requires its own
explicit task scope and the shared-lib publish/bump gate.

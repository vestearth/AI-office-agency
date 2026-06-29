# TASK-106: Backoffice Missions Weekly and Monthly UI-first views

## Short name
`backoffice-missions-weekly-monthly-ui`

## Type
feature

## Priority
medium

## Parent / Epic
- Depends on: `TASK-105`
- Epic: Backoffice Mission management

## Status

Done. Reviewer closed on 2026-06-29 after source review and build/validator
verification. Weekly and Monthly render from the query-aware Mission shell, with
current source including edit navigation/live weekly board support where later
contracts added it.

## Background

Weekly and Monthly are already exposed in Backoffice Mission navigation through
`/admin/manage/missions?type=weekly` and `?type=monthly`, but the current page
renders Daily content for every query state. Product direction is to build these
Backoffice views ourselves after the Daily foundation is fixed.

Shared UI reference: `ai-dev-office/runs/TASK-105/ui-reference/README.md`.

Attached task-specific references:

- `ai-dev-office/runs/TASK-105/ui-reference/work-captures/task-106-weekly-detailed-user-capture.png`
- `ai-dev-office/runs/TASK-105/ui-reference/work-captures/task-106-weekly-plan-screen.png`
- `ai-dev-office/runs/TASK-105/ui-reference/work-captures/task-106-weekly-edit-detail-screen.png`
- `ai-dev-office/runs/TASK-105/ui-reference/work-captures/task-106-weekly-schedule-screen.png`
- `ai-dev-office/runs/TASK-105/ui-reference/work-captures/task-106-weekly-board-overview-user-capture.png`
- `ai-dev-office/runs/TASK-105/ui-reference/work-captures/task-106-weekly-board-clean-highres.png`
- `ai-dev-office/runs/TASK-105/ui-reference/work-captures/task-106-monthly-detailed-user-capture.png`
- `ai-dev-office/runs/TASK-105/ui-reference/work-captures/task-106-monthly-plan-screen.png`
- `ai-dev-office/runs/TASK-105/ui-reference/work-captures/task-106-monthly-tabs-all-states.png`
- `ai-dev-office/runs/TASK-105/ui-reference/work-captures/task-106-monthly-edit-reward-screen.png`
- `ai-dev-office/runs/TASK-105/ui-reference/work-captures/task-106-monthly-schedule-screen.png`
- `ai-dev-office/runs/TASK-105/ui-reference/work-captures/task-106-monthly-board-overview-user-capture.png`
- `ai-dev-office/runs/TASK-105/ui-reference/work-captures/task-106-monthly-board-clean-highres.png`

## Goal

Add UI-first Weekly and Monthly Mission views and referenced edit/settings
screens that reuse the Mission shell from `TASK-105` and do not claim backend
persistence.

## Scope

### Target Services

| Service | Reason |
| --- | --- |
| `Games-Labs-backoffice` | Weekly and Monthly Mission admin UI views. |
| `ai-dev-office` | Backlog task tracking. |

### Likely Affected Files

| Path | Action | Description |
| --- | --- | --- |
| `Games-Labs-backoffice/app/pages/admin/manage/missions/index.vue` | modify | Render Weekly and Monthly views from the query-aware mission shell. |
| `Games-Labs-backoffice/app/components/mission/*` | modify | Reuse or add small mission list/table components only if existing components are insufficient. |
| `Games-Labs-backoffice/app/data/mock.ts` | modify | Reuse or minimally add mock data for Weekly/Monthly UI states. |
| `ai-dev-office/runs/TASK-106/*` | create | Task tracking artifacts. |

### Explicitly Excluded

- No backend, API, proto, or shared-lib changes.
- No real CRUD or persistence.
- No Invite UI.
- No Setting Default, Schedule, or Create Event flow.

## Acceptance Criteria

- [ ] Weekly query state renders Weekly Mission content, not Daily.
- [ ] Monthly query state renders Monthly Mission content, not Daily.
- [ ] Weekly and Monthly use bounded mock data and are clearly UI-first.
- [ ] Weekly and Monthly edit/settings screens follow attached references when included in the UI-only scope.
- [ ] Navigation and breadcrumb active states stay correct.
- [ ] UI follows the Daily/Mission visual system unless product supplies distinct Figma slices.
- [ ] `npm run build` passes in `Games-Labs-backoffice`.
- [ ] Screenshots for Weekly and Monthly are attached for PM review.

## Implementation Plan

1. Start from the query shell delivered in `TASK-105`.
2. Reuse existing mission card/table patterns where possible.
3. Add only the smallest mock additions needed to render believable Weekly and
   Monthly rows.
4. Build-verify and attach screenshots.

## Risks

- Weekly/Monthly detailed screen references are attached. Keep implementation
  UI-first and mock-only unless product separately scopes backend/admin contracts.

## Verification

- `cd Games-Labs-backoffice && npm run build`
- Manual smoke:
  - `/admin/manage/missions?type=weekly`
  - `/admin/manage/missions?type=monthly`

## Assignment

- Primary: `dev`
- Parallel: `false`

Reason: this should build on `TASK-105` and reuse the same mission shell.

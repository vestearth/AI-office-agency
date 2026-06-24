# TASK-109: Backoffice Missions Schedule flow clarification and UI

## Short name
`backoffice-missions-schedule-ui`

## Type
feature

## Priority
medium

## Parent / Epic
- Depends on: `TASK-108`
- Epic: Backoffice Mission management

## Status

Pending backlog. Do not implement until product confirms Schedule ownership and
acceptance slice.

## Background

Figma node `2333:24031` shows a Schedule area under Mission settings, including
time settings, weekday/activity controls, bonus/currency fields, mission
selection rows, and confirm/update flows. The current
`/admin/manage/missions/edit` page only shows a Schedule placeholder.

PM review flagged Schedule as a separate flow that may require product/backend
clarification before implementation.

Attached UI references:

- `ai-dev-office/runs/TASK-105/ui-reference/work-captures/task-105-108-109-daily-setting-schedule-user-capture.png`
- `ai-dev-office/runs/TASK-105/ui-reference/work-captures/task-106-weekly-schedule-screen.png`
- `ai-dev-office/runs/TASK-105/ui-reference/work-captures/task-106-monthly-schedule-screen.png`
- `ai-dev-office/runs/TASK-105/ui-reference/figma-setting-mission-schedule.png`

## Goal

Implement the Schedule UI flow after ownership, data model, and acceptance
criteria are confirmed.

## Scope

### Target Services

| Service | Reason |
| --- | --- |
| `Games-Labs-backoffice` | Schedule UI under Mission settings. |
| `ai-dev-office` | Backlog task tracking. |

### Likely Affected Files

| Path | Action | Description |
| --- | --- | --- |
| `Games-Labs-backoffice/app/pages/admin/manage/missions/edit/index.vue` | modify | Replace Schedule placeholder after clarification. |
| `Games-Labs-backoffice/app/components/mission/*` | modify | Reuse or add small schedule controls only if needed. |
| `Games-Labs-backoffice/app/data/mock.ts` | modify | Add bounded schedule mock data if no backend contract is in scope. |
| `ai-dev-office/runs/TASK-109/*` | create | Task tracking artifacts. |

### Explicitly Excluded

- No Create Event flow.
- No backend/API/proto/shared-lib work until a contract task explicitly scopes it.
- No real persistence unless product confirms the admin contract.
- No Weekly/Monthly/Invite work.

## Acceptance Criteria

- [ ] Product confirms whether Schedule belongs under Mission settings and whether it is UI-only or backend-backed.
- [ ] Schedule tab no longer shows a placeholder once implementation starts.
- [ ] Time setting, activity/weekday selection, bonus/currency, and mission selection follow the accepted Figma slice.
- [ ] Save/update confirmation states are represented according to accepted scope.
- [ ] If UI-only, no backend/API persistence claims are introduced.
- [ ] `npm run build` passes in `Games-Labs-backoffice`.
- [ ] Schedule screenshots are attached for PM review.

## Implementation Plan

1. Confirm Schedule ownership and whether this is UI-only or backend-backed.
2. If UI-only, implement bounded mock UI from the accepted Figma slice.
3. If backend-backed, stop and open/attach an API contract task before coding.
4. Build-verify and capture screenshots.

## Risks

- Schedule may cross from Mission UI into backend/admin activity group contracts.
  Implementing before clarification risks building the wrong flow.

## Verification

- `cd Games-Labs-backoffice && npm run build`
- Manual smoke: `/admin/manage/missions/edit` Schedule tab

## Assignment

- Primary: `dev`
- Parallel: `false`

Reason: separate flow with product clarification required before implementation.

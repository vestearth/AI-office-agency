# TASK-108: Backoffice Missions Setting Default Mission UI parity

## Short name
`backoffice-missions-setting-default-ui`

## Type
feature

## Priority
medium

## Parent / Epic
- Depends on: `TASK-105`
- Epic: Backoffice Mission management

## Status

Done. Reviewer closed on 2026-06-29 after source review and build/validator
verification. The Mission tab remains preview/local for default mission template
edits; the Schedule tab is covered separately by TASK-109.

## Background

The existing `/admin/manage/missions/edit` page has a Mission tab backed by mock
default mission data and a Schedule tab placeholder. Figma node `2333:24031`
shows a Setting Default area with Mission configuration forms for mission types
such as Game Turnover, Category Turnover, Any Game Turnover, and Spend Prop.

Attached UI references:

- `ai-dev-office/runs/TASK-105/ui-reference/work-captures/task-105-108-109-daily-setting-schedule-user-capture.png`
- `ai-dev-office/runs/TASK-105/ui-reference/figma-setting-mission-schedule.png`

## Goal

Finish the Setting Default Mission tab UI parity using the existing edit page and
mock/local state.

## Scope

### Target Services

| Service | Reason |
| --- | --- |
| `Games-Labs-backoffice` | Setting Default Mission admin UI. |
| `ai-dev-office` | Backlog task tracking. |

### Likely Affected Files

| Path | Action | Description |
| --- | --- | --- |
| `Games-Labs-backoffice/app/pages/admin/manage/missions/edit/index.vue` | modify | Complete Mission tab parity and keep Schedule out of scope. |
| `Games-Labs-backoffice/app/components/mission/DefaultMissionForm.vue` | modify | Reuse/adjust existing default mission form. |
| `Games-Labs-backoffice/app/components/mission/*` | modify | Reuse existing upload/tabs/controls where possible. |
| `Games-Labs-backoffice/app/data/mock.ts` | modify | Reuse or minimally add default mission mock data. |
| `ai-dev-office/runs/TASK-108/*` | create | Task tracking artifacts. |

### Explicitly Excluded

- No Schedule implementation.
- No Create Event flow.
- No backend, API, proto, or shared-lib changes.
- No real persistence unless a later task defines the admin contract.
- No broad redesign outside Mission Setting Default screens/components.

## Acceptance Criteria

- [ ] Setting Default Mission tab visually matches the Figma Mission slice closely enough for PM review.
- [ ] Mission types from the Figma slice are represented using existing/local mock data.
- [ ] Edit/cancel/update behavior remains local/mock-only unless a later contract task changes scope.
- [ ] Schedule tab remains explicitly out of scope or placeholder.
- [ ] No backend/API persistence claims are introduced.
- [ ] `npm run build` passes in `Games-Labs-backoffice`.
- [ ] Screenshot of the Setting Default Mission tab is attached for PM review.

## Implementation Plan

1. Reuse `/admin/manage/missions/edit` and existing mission components.
2. Tighten the Mission tab against the Figma slice.
3. Keep upload/update flows mock/local unless an existing safe helper already
   covers the preview behavior.
4. Build-verify and capture screenshot.

## Risks

- The current code references an upload category unrelated to missions. Confirm
  whether upload is preview-only or needs a separate storage-contract task before
  changing persistence behavior.

## Verification

- `cd Games-Labs-backoffice && npm run build`
- Manual smoke: `/admin/manage/missions/edit`

## Assignment

- Primary: `dev`
- Parallel: `false`

Reason: contained frontend parity task using existing Mission edit components.

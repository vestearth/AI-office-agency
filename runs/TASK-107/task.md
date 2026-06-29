# TASK-107: Backoffice Missions Invite UI-only view

## Short name
`backoffice-missions-invite-ui-only`

## Type
feature

## Priority
medium

## Parent / Epic
- Depends on: `TASK-105`
- Epic: Backoffice Mission management

## Status

Done. Reviewer closed on 2026-06-29 after source review and build/validator
verification. Invite remains bounded mock/UI-only with no backend persistence
introduced for this slice.

## Background

Invite is exposed in Backoffice Mission navigation through
`/admin/manage/missions?type=invite`. Product direction for this slice is UI
only; no backend logic exists in scope for this task.

Shared UI reference: `ai-dev-office/runs/TASK-105/ui-reference/README.md`.

Attached task-specific references:

- `ai-dev-office/runs/TASK-105/ui-reference/work-captures/task-107-invite-board-overview-user-capture.png`
- `ai-dev-office/runs/TASK-105/ui-reference/work-captures/task-107-invite-board-clean-highres.png`

## Goal

Add an Invite Mission admin view that is explicitly UI-only/mock-only and does
not introduce backend wiring.

## Scope

### Target Services

| Service | Reason |
| --- | --- |
| `Games-Labs-backoffice` | Invite Mission UI-only view. |
| `ai-dev-office` | Backlog task tracking. |

### Likely Affected Files

| Path | Action | Description |
| --- | --- | --- |
| `Games-Labs-backoffice/app/pages/admin/manage/missions/index.vue` | modify | Render Invite from the query-aware mission shell. |
| `Games-Labs-backoffice/app/components/mission/*` | modify | Reuse existing mission UI components where possible. |
| `Games-Labs-backoffice/app/data/mock.ts` | modify | Reuse or minimally add Invite mock rows. |
| `ai-dev-office/runs/TASK-107/*` | create | Task tracking artifacts. |

### Explicitly Excluded

- No backend, API, proto, or shared-lib changes.
- No Invite business logic.
- No real CRUD or persistence.
- No Weekly, Monthly, Setting, Schedule, or Create Event work.

## Acceptance Criteria

- [ ] Invite query state renders Invite content, not Daily.
- [ ] Invite is labeled or represented as UI-only/mock-only in implementation notes.
- [ ] No backend composables, API calls, or persistence are added.
- [ ] Navigation and breadcrumb active states stay correct.
- [ ] `npm run build` passes in `Games-Labs-backoffice`.
- [ ] Invite screenshot is attached for PM review.

## Implementation Plan

1. Start from the query shell delivered in `TASK-105`.
2. Render the smallest useful Invite UI state using existing Mission styling.
3. Keep all data local/mock.
4. Build-verify and attach screenshot.

## Risks

- The current Invite reference shows only the phase label/blank board area, not a
  detailed UI flow. This task deliberately stays UI-only until product supplies
  the detailed Invite slice or acceptance behavior.

## Verification

- `cd Games-Labs-backoffice && npm run build`
- Manual smoke: `/admin/manage/missions?type=invite`

## Assignment

- Primary: `dev`
- Parallel: `false`

Reason: small UI-only follow-up after the Mission shell exists.

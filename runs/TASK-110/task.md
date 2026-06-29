# TASK-110: Backoffice Missions Create Event flow clarification and UI

## Short name
`backoffice-missions-create-event-ui`

## Type
feature

## Priority
medium

## Parent / Epic
- Depends on: `TASK-105`
- Epic: Backoffice Mission management

## Status

Done. Reviewer closed on 2026-06-29 after source review and build/validator
verification. Event is the fifth Mission tab, and Create Event/Edit Event routes
are preview-only under `/admin/manage/missions/event/*`.

## Background

Figma node `2333:24031` shows a Create Event flow with a stepper:
Select Mission type, Detail and Condition, and Schedule. PM review flagged this
as separate from the first Mission shell task because it may cross into Event
management and backend/admin contracts.

Attached UI references:

- `ai-dev-office/runs/TASK-105/ui-reference/work-captures/task-110-event-create-flow-detailed-user-capture.png`
- `ai-dev-office/runs/TASK-105/ui-reference/figma-create-event-flow.png`

## Goal

Clarify ownership and implement the Create Event UI flow only after the accepted
product slice and backend/UI-only scope are confirmed.

## Scope

### Target Services

| Service | Reason |
| --- | --- |
| `Games-Labs-backoffice` | Create Event UI flow if confirmed under Backoffice Missions. |
| `ai-dev-office` | Backlog task tracking. |

### Likely Affected Files

| Path | Action | Description |
| --- | --- | --- |
| `Games-Labs-backoffice/app/pages/admin/manage/missions/*` | modify | Add or route Create Event flow only after ownership is confirmed. |
| `Games-Labs-backoffice/app/components/mission/*` | modify | Reuse or add stepper/form components only if needed. |
| `Games-Labs-backoffice/app/data/mock.ts` | modify | Add bounded mock data if no backend contract is in scope. |
| `ai-dev-office/runs/TASK-110/*` | create | Task tracking artifacts. |

### Explicitly Excluded

- No backend/API/proto/shared-lib work until a contract task explicitly scopes it.
- No event persistence unless product confirms the admin contract.
- No Schedule backend wiring from TASK-109 unless explicitly linked.
- No broad redesign outside the accepted Create Event route/screen.

## Acceptance Criteria

- [ ] Product confirms whether Create Event belongs under Mission or Event management.
- [ ] Product confirms UI-only vs backend-backed scope before implementation.
- [ ] Accepted flow includes Select Mission Type, Detail and Condition, and Schedule steps.
- [ ] Confirmation/success states follow the accepted Figma slice.
- [ ] If UI-only, no backend/API persistence claims are introduced.
- [ ] `npm run build` passes in `Games-Labs-backoffice`.
- [ ] Create Event screenshots are attached for PM review.

## Implementation Plan

1. Confirm ownership and route placement.
2. Confirm whether the flow is UI-only or requires backend/admin contracts.
3. If UI-only, build the smallest stepper flow from the accepted Figma slice.
4. If backend-backed, stop and open/attach API contract work first.
5. Build-verify and capture screenshots.

## Risks

- Create Event may belong to another Backoffice area or require admin event APIs.
  Building it under Missions before clarification can create throwaway UI.

## Verification

- `cd Games-Labs-backoffice && npm run build`
- Manual smoke path to be confirmed after route ownership is decided.

## Assignment

- Primary: `dev`
- Parallel: `false`

Reason: ownership and contract uncertainty must be settled before coding.

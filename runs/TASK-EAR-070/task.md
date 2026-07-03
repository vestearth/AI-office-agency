# TASK-EAR-070: Align Backoffice Event Mission UI with Figma

## Short name

`event-mission-figma-ui`

## Type

feature

## Workstream

frontend

## Created

2026-07-03

## Goal

Bring the Backoffice Event Mission admin UI closer to the provided Figma design
for `/admin/manage/missions?type=event`.

The current authenticated review found that the functional event flow exists,
but several screens do not match the Figma layout closely enough to approve:

- Event list page with real data.
- Create Event step 1: Select Mission Type.
- Create Event step 2: Detail and Condition plus game selection.
- Create Event step 3: Schedule.
- Edit Event page.

## Evidence From Review

Figma references copied from the user-provided images:

- `ai-dev-office/runs/TASK-EAR-070/artifacts/figma-reference-overview.png`
- `ai-dev-office/runs/TASK-EAR-070/artifacts/figma-reference-create-step1.png`
- `ai-dev-office/runs/TASK-EAR-070/artifacts/figma-reference-create-step2-a.png`
- `ai-dev-office/runs/TASK-EAR-070/artifacts/figma-reference-create-step2-b.png`

Authenticated Backoffice screenshots captured from `http://127.0.0.1:3010`:

- `ai-dev-office/runs/TASK-EAR-070/artifacts/current-event-list.png`
- `ai-dev-office/runs/TASK-EAR-070/artifacts/current-create-step1.png`
- `ai-dev-office/runs/TASK-EAR-070/artifacts/current-create-step2.png`
- `ai-dev-office/runs/TASK-EAR-070/artifacts/current-create-step3.png`
- `ai-dev-office/runs/TASK-EAR-070/artifacts/current-edit-event.png`

Observed gaps:

- The create flow uses a full-page segmented card wizard rather than the Figma
  stepper/progress layout shown in the provided references.
- Step 2 displays the full live game catalog grid immediately, while the Figma
  reference emphasizes selected-game ordering/management.
- Step 3 is a simple schedule card and does not visually match the Figma
  schedule panel/reference state.
- Edit Event is a long form with summary cards and sticky footer, not the same
  visual flow as the Figma references.
- Event list renders real rows, but column framing and right-side controls need
  review against the Figma board/list state.

## Scope

Target service:

- `Games-Labs-backoffice` — Nuxt/Vue Backoffice frontend only.

Likely affected files:

- `Games-Labs-backoffice/app/pages/admin/manage/missions/index.vue`
- `Games-Labs-backoffice/app/components/mission/EventPlanCard.vue`
- `Games-Labs-backoffice/app/pages/admin/manage/missions/event/create.vue`
- `Games-Labs-backoffice/app/pages/admin/manage/missions/event/edit/[id].vue`
- `Games-Labs-backoffice/app/components/mission/EventStepper.vue`
- `Games-Labs-backoffice/app/components/mission/EventGameSelector.vue`
- Related shared mission UI components only if needed, such as
  `SegmentedTabs.vue`, `ThumbnailUpload.vue`, and `NumberStepper.vue`.

Out of scope unless a confirmed UI contract gap requires escalation:

- Backend API changes.
- `shared-lib` changes.
- Proto/gRPC changes.
- Database migrations.
- Event mission runtime semantics.

## Acceptance Criteria

- Event list, Create Event steps 1-3, and Edit Event are visually aligned with
  the provided Figma references as closely as possible within the existing
  Backoffice design system.
- Event list with authenticated data keeps search, status tabs, pagination,
  active toggle, delete, and edit affordances usable and visible at the reviewed
  desktop viewport.
- Create Step 1 matches the Figma mission-type selection layout, including
  stepper/progress treatment, row spacing, selected state, and action placement.
- Create Step 2 matches the Figma Detail and Condition layout while preserving
  live game catalog selection and validation.
- Create Step 3 matches the Figma schedule state or explicitly documents any
  missing Figma reference detail that prevents exact alignment.
- Edit Event uses the approved Figma-aligned visual pattern, or the task output
  documents why Edit intentionally differs from Create.
- `npm run build` passes in `Games-Labs-backoffice`.
- Authenticated browser smoke is performed for:
  - `/admin/manage/missions?type=event`
  - `/admin/manage/missions/event/create`
  - at least one existing `/admin/manage/missions/event/edit/:id`

## Plan

1. Re-open the provided Figma screenshots and the authenticated screenshots
   listed above; decide the canonical layout for list/create/edit.
2. Update the Event list table/card layout so the right-side controls remain
   visible and the row styling matches the Figma board/list reference.
3. Update `EventStepper` and the create page shell to match the Figma stepper
   and wizard container more closely.
4. Update Create Step 1 mission-type rows to match Figma spacing, selected
   radio/check treatment, condition pill placement, and footer buttons.
5. Update Create Step 2 detail form and game selector presentation to match the
   Figma detail/game-selected layout without breaking live catalog selection.
6. Update Create Step 3 schedule layout to match the Figma schedule reference.
7. Update Edit Event to either reuse the Figma-aligned create/edit pattern or
   document and implement the intended edit-specific visual treatment.
8. Verify build and authenticated browser smoke.

## Assignment

Primary agent: `dev`

Reason: focused Backoffice frontend/UI alignment in a single service. Keep the
work sequential because the same page and shared mission components interact.

## Risks

- The Figma overview screenshot is zoomed out and may not contain enough detail
  for every state, especially Edit and Schedule.
  - Mitigation: implement the visible states first and ask for additional Figma
    exports when exact layout cannot be inferred.
- Changing shared mission components can affect daily/weekly/monthly mission
  pages.
  - Mitigation: keep component edits scoped to event-specific components where
    possible, and smoke the Event flow after changes.
- Live authenticated data can differ between local runs.
  - Mitigation: verify layout behavior with at least one real event row and
    avoid relying on fixed row content.

## Next Action

Run:

```bash
./ai-dev-office/run-agent.sh TASK-EAR-070 dev
```

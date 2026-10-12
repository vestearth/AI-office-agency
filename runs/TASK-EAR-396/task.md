# TASK-EAR-396: Backoffice: stop offering CATEGORY_TURNOVER / ANY_GAME_TURNOVER on event missions

Owner: Games-Labs-backoffice (PR to `main`). Follow-up of TASK-EAR-391.

## Problem

Missions now refuses these two event condition types, live on staging `9bb81d5` since
2026-10-09T18:52Z (TASK-EAR-391, evidence `runs/TASK-EAR-391/evidence/ev-007-staging-acceptance.log`):

- `POST /api/v1/admin/missions/events` and `PUT .../{event_id}` with a CATEGORY_TURNOVER or
  ANY_GAME_TURNOVER condition → 400 `condition type X has no progress tracking yet`.
- `PATCH .../{event_id}/active` with `active:true` on a stored event of either type → same 400.
  Deactivate and delete still work.

The Backoffice event create page still offers both types. An admin fills in the whole form
and only gets the error on save.

## Where (origin/main)

- `app/pages/admin/manage/missions/event/create.vue`: `typeOptions` (~L100) is built from
  `dailyDefaultMissionOrder`, which lists all four types. It is rendered at ~L277.
- `app/pages/admin/manage/missions/event/edit/[id].vue`: loads the stored type (~L66).
  Saving an existing CATEGORY/ANY event now always returns 400.
- `app/components/mission/EventPlanCard.vue` `toggleActive` (~L239): activating such an event
  now returns 400 and shows `Failed to update status: ...`.
- `app/composables/useAdminMissionApi.ts`: a gateway 400 most likely throws from the fetch
  layer before `unwrap()`, so the toast probably shows a generic status, not the server reason.
  **Unverified:** check the real toast text on admin-dev first.

**Trap:** `dailyDefaultMissionOrder` and `mockDailyDefaultMissions` are shared with **daily
missions**, which do support Category and Any Game Turnover. Filter only on the event pages.
Do not change the shared order or `eventMissionMap.ts` mappings, because stored events must
still read back and label correctly.

## Outcome

1. Event create offers only Game Turnover and Spend Prop. Daily mission forms are unchanged.
2. Event edit for an existing CATEGORY/ANY event: the type is shown but saving is not offered,
   or is clearly explained. It must not fail silently or with a generic toast. The admin can
   still deactivate or delete it from the list.
3. The list's activate toggle on such an event shows the server reason, or is disabled with that
   reason.
4. Stored CATEGORY/ANY events still list and label as before (staging has
   `play-by-game-5470cb66`, `play-by-game-929489d8`, `play-by-game-13ee6176`,
   `play-by-game-test-fb68a204`, `play-any-game-ddf3658a`, `play-any-game-eeeee-599ab214`).

The UI is design-approved (see memory "Preserve UX design, wire data only"). Remove or disable
options inside the existing components. Do not redesign the type picker. If hide versus disable
needs a design call, ask the operator before building.

## Verification

- Unit/component test: event create `typeOptions` excludes both types, and the daily mission
  form still includes them. See it fail first.
- Authenticated staging smoke on admin-dev after the ArgoCD sync, not just a green
  "Build and Deploy" (memory: GitOps sha pin). Re-fetch the page to confirm the new build:
  create picker, edit page of `play-by-game-929489d8`, list toggle on it. Do not create events
  on staging unless needed. If you do, deactivate them afterwards.

## Out of scope

- Progress tracking for these types (a future task, undecided).
- Missions changes (done in TASK-EAR-391).
- The 0/0 item "done" state on the player detail (TASK-EAR-394).

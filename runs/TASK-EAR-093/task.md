# TASK-EAR-093: Weekly edit — 4-type Select Mission roster completion

## Short Name

`weekly-edit-roster`

## Type

bugfix (FE, Games-Labs-backoffice)

## Priority

medium

## Parent / Epic

- Epic: Missions admin manage — Weekly
- Related: TASK-EAR-079 (schedule generator; weekly game_turnover deliberately
  excluded from auto-generation), backoffice commit 204a5e6 (daily roster
  completion, 2026-07-06), 369d8be (weekly default thumbnails, 2026-07-09)
- Origin: operator report 2026-07-10 (Thai) — on
  `admin/manage/missions/weekly/edit`, Setting shows 4 mission types but the
  edit page "Select Mission" list shows only 3.

## Root cause

Two layers, confirmed with file:line evidence (Claude advisory lane +
2 Explore subagents, 2026-07-10):

1. Backend (by design, v1): the weekly schedule generator never emits a
   `game_turnover` → `TURNOVER_GAME_POOL` activity because the default
   template carries no game-id pool
   (Games-Labs-Missions internal/services/schedule_defaults.go:48-59,
   107-113; unit-tested at schedule_defaults_test.go:76-79). Generated weekly
   plans therefore contain at most 3 condition types. Save/detail/DB are
   type-agnostic — `TURNOVER_GAME_POOL` is fully supported when supplied
   (internal/services/weekly_admin.go:166-176).
2. Frontend (the bug to fix): commit 204a5e6 added roster completion to the
   DAILY edit page only (`toRoster`/`seedDefaultTask`,
   daily/edit/[id].vue:230-266) — the Select Mission list always shows the
   full 4-type roster, with missing types seeded unchecked from the Default
   Mission templates. The WEEKLY edit page never received the equivalent:
   `applyDetail` maps `detail.activities` 1:1 (weekly/edit/[id].vue:125-141),
   so a 3-activity plan renders 3 rows and the operator cannot add the 4th
   type from the edit page at all.

## Scope

`Games-Labs-backoffice/app/pages/admin/manage/missions/weekly/edit/[id].vue`
(port of the daily 204a5e6 pattern):

1. Add `typeFromLabel`, `seedDefaultTask` (seeds from the already-loaded
   weekly `defaultTemplates` via `resolveMissionName`), and `toRoster`
   (present types kept + marked selected, missing types seeded unchecked, in
   `weeklyDefaultMissionOrder`).
2. `applyDetail`: `store.tasks = toRoster(tasks, planId)`; mock-fallback path
   in `loadPlan` also expands to the roster (daily parity).
3. Selection mirror (daily parity): `selectedTaskIds` ref bound to the
   editor's `update:selected`; Total Mission card counts selected only;
   `missionRewardTotal` computed over selected tasks only (unchecked seeds
   must not inflate Total Reward / group reward).
4. `toApiActivity` id scheme: adopt daily's `startsWith` guard so ids are not
   re-prefixed with planId on every save round-trip (also makes seeded
   `${planId}-${type}` ids stable).

## Non-goals

- No backend/generator change: weekly `game_turnover` auto-generation stays
  excluded (v1 decision, TASK-EAR-079) — the fix makes it addable manually
  per plan from the edit page, which the backend already validates/accepts.
- No changes to daily/monthly/event pages or MissionPlanPeriodEditor.
- No changes to the weekly Settings page (its 4-item checklist is correct).

## Acceptance

- Weekly edit "Select Mission" always lists exactly 4 rows: plan activities
  checked, missing types unchecked seeds (name resolved from the weekly
  Default Mission template, correct condition/threshold text, template
  thumbnail).
- Checking a seeded game_turnover and picking games saves as
  `TURNOVER_GAME_POOL` (existing guards intact: catalog-loaded check, ≥1 game
  per pool, mixed-currency block). Unchecked seeds are not persisted.
- Total Mission / Total Reward cards reflect selected missions only.
- Existing tests pass; nuxt build green; browser-verified on dev server.

## Notes

- Work in the main working tree (clean at start, no concurrent session
  observed) on branch feature/TASK-EAR-093-weekly-edit-roster off main
  4f2df3d.
- Claude (Fable 5) manual advisory lane doing the implementation with
  Explore subagents for evidence; provenance in reasons, enum fields stay
  within the validator enum.

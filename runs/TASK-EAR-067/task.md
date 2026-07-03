# TASK-EAR-067: Fix event create form defaults (dates + name placeholder)

## Short name

`event-create-defaults`

## Type

bugfix

## Workstream

frontend (Games-Labs-backoffice)

## Created

2026-07-03

## Goal

Two frontend defaults on the event create form caused confusing output when
the operator created an event without editing every field.

## Root cause

1. **Hardcoded past dates:** `create.vue` defaulted `startDate = '2026-03-04'`,
   `endDate = '2026-03-25'` — in the past relative to today, so every unedited
   create landed in the "Ended" tab (backend state `expired`). The board-state
   logic was correct; the defaults were stale.
2. **Unresolved name placeholder:** the per-type default names come from the
   shared `mockDailyDefaultMissions` templates which carry `{...}` tokens
   (e.g. `Play {Number of total game} Game`). Events have no substitution step,
   so the literal braces were persisted as the mission title.

## Fix (frontend only, `Games-Labs-backoffice`)

- `create.vue`: default window = today → today+7 via local date parts
  (`toYmd(new Date())`), replacing the hardcoded past dates.
- `create.vue`: after cloning the default templates, strip `{...}` tokens from
  `missionName`/`description` and collapse whitespace, so a clean editable
  default is shown/persisted (`Play {Number of total game} Game` → `Play Game`).

Edit page needs no change: it fills dates/title from the saved event.

## Verification

- `npx nuxi typecheck`: pre-existing baseline errors only, zero in create.vue.
- Pure-logic check: name strip yields `Play Game` / `Play by Game`, leaves
  non-placeholder names intact; dates resolve to today (2026-07-03) → +7
  (2026-07-10) so a new event is Upcoming, not Ended.
- Browser smoke test not run: the create page is behind admin auth on a live
  backend; the two changes are deterministic pure transforms verified directly.

## Scope

Branch `fix/TASK-EAR-067-event-create-defaults` from `main`. Frontend only; no
backend/contract change.

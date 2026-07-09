# TASK-EAR-092: Restore Streak editor + Figma copy sync (Monthly check-in surfaces)

## Short Name

`restore-streak-editor`

## Type

feature (FE, Games-Labs-backoffice)

## Priority

medium

## Parent / Epic

- Epic: Missions admin manage — Monthly / Check-in Calendar
- Related: TASK-EAR-076 (check-in camelCase fix), TASK-EAR-090 (POINT currency)
- Origin: operator request 2026-07-09 — Figma latest
  (BackOffice--GAMESLAB, nodes 2731-45006 monthly edit incl. Restore Streak
  card 2731-45147; 5211-87446 settings/Default Mission; 4944-79780 monthly
  flow overview) adds a Restore Streak price-ladder editor that the code never
  had. Operator confirmed: restore prices ARE editable (reverses the earlier
  "fixed default" decision recorded in Games-Labs-backoffice commit 0a4d58b).

## Scope

Both Monthly check-in admin surfaces in Games-Labs-backoffice:

1. `app/pages/admin/manage/missions/monthly/edit/[id].vue`
   - Add "Restore Streak" section per Figma node 2731-45147: 5 fixed columns
     (Day 1..Day 4, Day 5+), each = Pricing (NumberStepper) + Currency select.
   - Bind to `store.restoreStreak` (already round-tripped via
     `buildCheckInConfig()` → `restore.price_ladder`).
   - Fixed 5 rows: normalize loaded ladder to exactly 5 entries
     (restore_number 1..5); Day 5+ = the flat rate for restore #5 onward
     (backend `restorePrice()` clamps to last step — verified
     Games-Labs-Missions internal/services/check_in_calendar_service.go:906).
   - Currency: design shows a dropdown per day but the backend contract has ONE
     `restore.currency` for the whole ladder → keep 5 dropdowns visually,
     synced to a single shared currency value.
   - `max_restores_per_month: 0` stays (0 = unlimited, operator-confirmed).
   - viewOnly (past months): restore inputs disabled like the other sections.
2. `app/pages/admin/manage/missions/monthly/settings.vue` (Default Mission tab)
   - Same Restore Streak editor for the template
     (`mission_config.check_in_template.restore`). Replace the
     stash-and-pass-through `loadedRestore` behavior with the editable ladder;
     rewrite the 0a4d58b comment block (its premise is now wrong).
3. Copy sync per Figma (both pages): bonus add action = centered
   "Add Bonus Reward" row with plus icon (was top-right "Add row" button);
   day dropdown last option label "EOM (END of Month)" (was "EOM").

## Non-goals

- No backend/proto changes (contract already carries restore config both ways).
- No enforcement change for max_restores_per_month (stays 0/unlimited).
- No mobile/public surface changes.

## Acceptance

- Both pages render the Restore Streak card (5 fixed day columns) styled with
  existing design-system classes (bg-background-50 card, white day cards,
  rounded-r24, NumberStepper, custom-chevron select — no bare native select).
- Editing prices on Monthly edit persists via PUT /api/v1/admin/check-in/config
  (`restore.price_ladder` 5 steps, single currency, max_restores_per_month 0).
- Editing prices on Settings persists via PUT /api/v1/admin/missions/config
  (`check_in_template.restore`), and a settings save no longer blindly
  round-trips the stashed restore.
- Bonus "Add Bonus Reward" + "EOM (END of Month)" copy on both pages.
- Existing tests pass; nuxt build green.

## Notes

- Work happens in an isolated worktree
  (scratchpad GL-backoffice-EAR092, branch
  feature/TASK-EAR-092-restore-streak-editor off main fff207e) because the main
  working tree had a concurrent live session (observed branch switch + rewrites
  at 14:48; my settings.vue comment edit was auto-committed as 0a4d58b by that
  session's tooling).
- Claude (Opus 4.8) manual advisory lane doing the implementation; provenance
  in reasons, enum fields stay within the validator enum.

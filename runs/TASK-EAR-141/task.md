# TASK-EAR-141: Backoffice — mission category guard (options with zero backing games)

## Type

bug

## Workstream

frontend

## Priority

medium

## Created

2026-07-18

## Goal

Follow-up from TASK-EAR-140. The Category Turnover config surfaces let an
admin pick a category that matches **zero** games in the catalog, producing a
mission that can never progress, with no warning:

- Dropdown options are a hardcoded list (`dailyMissionGameCategoryOptions` in
  `Games-Labs-backoffice/app/data/mock.ts`: `All/Slot/Card/Crash/Arcade/Mini
  Game`). On staging today, `Card` and `Arcade` match no `games.game_type`
  value at all.
- The "All games in {category} are included (N games)" preview
  (`MissionPlanPeriodEditor.vue` / `gamesInMissionCategory`) counts by
  `games.category`, but the Missions runtime matches events on
  `games.game_type` (see TASK-EAR-140). The preview can show N > 0 while the
  runtime matches nothing, and vice versa.

## Fix (this task)

In Games-Labs-backoffice (mission editors: Setting Default mission form,
daily/weekly period editors, event create/edit where category turnover
appears):

1. Count the included-games preview from the catalog's `game_type` field
   (admin ListGames already returns `gameType` — see
   `useAdminGamesCatalog.ts`), using the same normalize+contains semantics as
   the Missions matcher (`normalizeGameCategoryKey` + containment either way)
   so preview and runtime agree.
2. When the selected category matches 0 games, show a clear inline warning on
   the field ("no games in the catalog match this category — this mission
   will never progress") and keep the save gated or explicitly acknowledged.
3. Keep the existing UX design — data-source and validation changes only, no
   component redesign (operator standing rule).

Dropdown remains the curated list for now; making it live-driven from distinct
`game_type` values belongs to the canonical-enum epic (see knowledge-base:
"Game Type Vocabulary — Root Cause + Canonical Enum Epic Plan").

## Acceptance

- Preview count for a category equals the number of games whose `game_type`
  fuzzy-matches the category token (spot-check: Slot > 0, Card = 0 on staging
  data).
- Zero-match category shows the warning on every surface where category
  turnover is configured.
- Existing tests pass; add/extend a unit test for the new preview counting
  helper.
- FE only; lands on backoffice `main` per current deploy topology.

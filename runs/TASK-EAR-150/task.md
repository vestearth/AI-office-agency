# TASK-EAR-150: Game classification epic — Phase 4: Backoffice dropdown/preview from taxonomy

## Type

feature

## Workstream

frontend

## Priority

medium

## Created

2026-07-18

## Epic

Canonical game-classification — Phase 4 of 5. Depends on TASK-EAR-147 (Game
taxonomy list endpoint) and TASK-EAR-149 (Missions admin API accepts
game_category). **Supersedes TASK-EAR-141** (interim zero-game guard).

## Goal

Drive the mission category dropdown and the included-games preview from the
live Game taxonomy, so the config UI offers only real categories and its
preview matches exactly what the runtime scores.

## Scope (Games-Labs-backoffice)

1. Replace the hardcoded `dailyMissionGameCategoryOptions`
   (`app/data/mock.ts`) with the live Game taxonomy list endpoint
   (TASK-EAR-147) across the mission editors (Setting Default form,
   daily/weekly period editors, event create/edit).
2. Save writes `game_category.code` to the Missions admin API (149).
3. Preview counts games by **assigned game_category** (exact), not by fuzzy
   `games.category`; warn (and gate) when a category matches zero games —
   this absorbs the TASK-EAR-141 guard.
4. Preserve the approved UX design — data-source and validation changes only,
   no component redesign (operator standing rule).

## Acceptance

- Dropdown reflects the live taxonomy (no hardcoded list, no dead options).
- Preview count == games assigned to that `game_category`.
- Zero-game category warns on every surface where category turnover is
  configured.
- Save persists `game_category`; `npm run build` green. Lands on backoffice
  `main` (live deploy — backoffice main is still k3s/ArgoCD).

## Note

Close TASK-EAR-141 as superseded once this ships (or keep 141 as an interim
guard on the hardcoded list if the epic runs long — operator's call).

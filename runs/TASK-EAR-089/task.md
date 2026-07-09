# TASK-EAR-089: Backoffice — daily editor per-slot game replace + real Re-random shuffle

## Short Name

`backoffice-daily-game-picker-and-shuffle`

## Type

feature + bugfix (FE-only)

## Priority

medium

## Parent / Epic

- Epic: Missions admin manage (daily plan board)
- Sibling: TASK-EAR-088 (backend fixes from the same operator report)

## Background

Operator report 2026-07-09 on `admin/manage/missions/daily/edit`:

- "Add game" picks a specific game but "Re-random" replaces the whole set —
  they want to replace a single slot while editing.
- The random pool feels tiny.

Source-verified findings:

- `rerandom()` (`app/components/mission/MissionPlanPeriodEditor.vue:212-217`)
  is **not random**: `catalog.filter(not selected).slice(0, N)` always takes the
  first N unselected games in catalog order, so repeated clicks oscillate
  between the same ~2×N head-of-list games. The catalog itself is the full
  un-paginated `GET /api/v1/admin/games` list (`useAdminGamesCatalog.ts`), so
  the pool is not actually small.
- `MissionSelectedGameManager.vue` has per-card remove + append-only Add game;
  no per-slot replace affordance.
- The working tree already carries uncommitted prior-session work converting
  the Add-game tile from "auto-add next" to an explicit game `<select>`
  (+ `tests/missionSelectedGameManager.test.mjs`). That work is adopted as the
  base commit of this task — do not discard it.

## Scope

Branch `feature/TASK-EAR-089-daily-game-picker` cut from `main` (Backoffice has
no staging branch; FE lands on main).

1. Commit the pre-existing working-tree changes as the base commit
   (provenance noted in the message).
2. Real shuffle: rewrite `rerandom()` to Fisher-Yates over the catalog
   excluding the current selection, take N; top up randomly from the remainder
   if fewer than N are available. Client-side only — no API change.
3. Per-slot replace: each selected-game card in
   `MissionSelectedGameManager.vue` gets a swap control that replaces that
   slot's game id in place (swap at `modelIndex` via `update:modelValue`),
   options from the existing `availableGames` computed.
4. Select styling: all selects in the touched components follow the
   custom-chevron pattern (wrapper + `appearance-none` +
   `lucide:chevron-down` overlay, `pointer-events-none`) — no bare native
   selects ship (standing Backoffice feedback).
5. Tests extended for the new behaviors, repo test suite green.

## Out of Scope

- Backend/API changes (save payload stays `activities[].game_id`).
- The two unrelated unpushed commits already on local `main` (they ride along).
- Other pages' selects.

## Acceptance Criteria

1. Editing a daily plan allows replacing one game in place without touching
   the other slots; Total Game count unchanged by a swap.
2. Re-random produces a genuinely random same-size selection drawn from the
   whole catalog (excluding the current set when possible), different across
   repeated clicks when the catalog allows.
3. Prior-session Add-game select work is preserved and committed with
   provenance.
4. No bare native `<select>` remains in the touched components.
5. Repo tests pass, including new/updated tests for swap + shuffle.

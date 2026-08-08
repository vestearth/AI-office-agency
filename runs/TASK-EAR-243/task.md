# TASK-EAR-243 — Backoffice: lock PlayersListTable header radius + sticky admin/games thead

## Type

bugfix

## Workstream

frontend

## Priority

medium

## Created

2026-08-08

## Context

Operator report (screenshots):

1. Players list (`Username` / `Manage` header ends): border-radius looks
   "unlocked" — top corners round (from outer scroll shell clip) but bottom
   corners stay square. Radius should stay locked on **both** top and bottom
   of the header end cells at all times (including sticky).
2. `admin/games` Game List: table head must remain visible while scrolling
   the table body (sticky thead).

## Goal

- PlayersListTable first/last header cells always show full left/right
  capsule radius (top + bottom).
- admin/games list table header sticks for the table scroll viewport.

## Scope

- Included:
  - `Games-Labs-backoffice/app/components/PlayersListTable.vue`
  - `Games-Labs-backoffice/app/pages/admin/games/index.vue`
- Excluded: API/data, other admin tables unless same one-line sticky pattern
  is free while touching games.

## Acceptance Criteria

- Username (left) and Manage (right) header cells show rounded top **and**
  bottom corners at scroll top and while sticky.
- admin/games thead stays pinned in the table scroll region when scrolling down.
- No layout/column/behavior regressions on player list or game list.

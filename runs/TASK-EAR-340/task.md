# TASK-EAR-340 — Player list Lifetime GGR tooltip

## Type

feature

## Workstream

frontend

## Priority

medium

## Created

2026-09-09

## Parent / Epic

- Parent: TASK-EAR-320 (admin GGR read-through)
- Product locks from the same thread:
  - Mobile `lifetime_ggr` stays 0 (do not wire Game into GetProfile)
  - Keep the backoffice column name **Lifetime GGR**; add a tooltip
  - Monitoring report mock is out of scope

## Goal

`PlayersListTable` keeps the Figma label `Lifetime GGR` and tells operators
that the number is captured-rounds only, not a full lifetime total.

## Scope

In:
- `Games-Labs-backoffice/app/components/PlayersListTable.vue`
- Focused source test next to the existing table-head checks

Out:
- Mobile profile GGR
- Monitoring / Report / Player (still mock)
- Column rename
- Shared tooltip component
- `Games-Lab-Android/`

## Acceptance criteria

- Column label remains `Lifetime GGR`
- Header has an info control whose tooltip/title says the figure counts
  captured rounds only and is not a full lifetime total
- Existing table-head tests still pass

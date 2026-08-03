# TASK-EAR-195 — Player Detail: pagination/Showing must not overlap the table

## Type

bugfix

## Workstream

frontend

## Priority

medium

## Created

2026-08-01

## Context

Follow-up to TASK-EAR-175. That task synced the History/Game **table card**
bottom to the Summary panel on `lg+`. Pagination stayed in a sibling grid row
*below* the card. The forced card height still reaches Summary's bottom, so
the Showing + pager strip collides with / crowds the table body (operator
report on Game → Last played).

## Goal

Pagination and the "Showing X to Y of Z entries" line sit in a clear footer
band under the scrollable table — no overlap — while `lg+` card bottom still
tracks Summary. Footer layout should wrap flexibly on narrower widths.

## Scope

- Included:
  - `Games-Labs-backoffice/app/pages/admin/manage/player/Detail/[id].vue`
  - `Games-Labs-backoffice/app/components/AdminDataTablePagination.vue` (flex wrap / min-width only)
- Excluded: API/data, Basic Info, mobile equal-height (still none)

## Acceptance Criteria

- On Game and History tabs, the last table row never visually overlaps Showing or pager controls.
- Table body remains the only scrolling region; footer stays visible (`shrink-0`).
- On `lg+`, the table **card** (including footer) bottom still aligns with Summary.
- Below `lg`, no forced equal height.
- Showing + pager wrap instead of colliding when horizontal space is tight.

## Notes

- Prefer moving pagination **inside** the table card as a footer over subtracting
  measured heights from `syncDetailTableHeightToSummary` (more reliable).

# TASK-EAR-244 — Backoffice: sweep the outset table-head hairline across remaining tables

## Type

bugfix

## Workstream

frontend

## Priority

low

## Created

2026-08-09

## Context

Follow-up to TASK-EAR-243 (PR #90, merged). That task proved the mechanism:
a table head hairline written as an **outset** `box-shadow`
(`shadow-[0_1px_0_...]`) is painted 1px *below* the element's box, so nothing
can mask it and it draws a straight line across the rounded ends of the head
capsule. TASK-EAR-243 fixed only `PlayersListTable.vue` and
`app/pages/admin/games/index.vue`.

Operator reported the same line on
`/admin/manage/promotion/free-coin` (Audit Log: First-Time Login modal) and
asked for a sweep of the other tables with the same shape.

Known occurrences of `shadow-[0_1px_0_`:

- `app/pages/admin/manage/promotion/free-coin.vue` (hairline on `<thead>`)
- `app/components/PlayerAuditLogModal.vue` (hairline on `<thead>`)
- `app/pages/admin/manage/vip/index.vue` (per-`th`, `rounded-l/r-full` ends)
- `app/pages/admin/manage/redemption/library/index.vue` (per-`th`, `r24` ends)
- `app/pages/admin/manage/redemption/tracking/index.vue` (per-`th`, `r24` ends)
- `app/pages/admin/manage/redemption/items.vue` (per-`th`, ends to be checked)

## Goal

No table head hairline crosses the rounded end of its head capsule, at any
scroll position.

## Scope

- Included: the six files listed above.
- Excluded: any change to column layout, data wiring, or head geometry
  (radius values, row height). Hairline rendering only, plus whatever
  minimum is needed to stop content behind a rounded end showing through.

## Acceptance Criteria

- Each affected head renders with its hairline following the capsule ends
  rather than cutting across them, verified in the browser, not only in
  source.
- Tables whose heads have square ends are confirmed unaffected and left
  alone rather than changed for consistency.
- Focused source test extends the TASK-EAR-243 regression assert to the
  swept files.
- No layout, column, or behaviour regressions.

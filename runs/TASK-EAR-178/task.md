# TASK-EAR-178 — Align admin/games/group list table shell with Game List

## Type

bugfix

## Workstream

frontend

## Priority

medium

## Created

2026-07-31

## Context

Operator reported that the table UI on `admin/games/group` does not match
other admin list tables. Visual comparison against sibling page
`admin/games` (Game List):

- Game List: flat `bg-background-50` card; table scrolls in a simple
  `overflow-hidden rounded-r24` shell; pagination outside the card.
- Group: grey `bg-background-200` card wrapping an extra white bordered
  nested card around a bordered scroll region — looks like a card-in-card.

## Goal

Make Highlight / Level / Custom group list tables use the same table shell
as `admin/games` Game List.

## Scope

- Included: `Games-Labs-backoffice/app/pages/admin/games/group/index.vue`
- Excluded: edit page, API/data changes, tab/search bar redesign, column set

## Acceptance Criteria

- Group list section card uses `bg-background-50` (not nested white card).
- Table sits in the Game List-style overflow shell (no extra border wrapper).
- Pagination sits below the table card (sibling), matching Game List.
- Highlight / Level / Custom columns, rows, and actions unchanged.
- Tabs + search bar layout preserved.

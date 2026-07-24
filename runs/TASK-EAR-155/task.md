# TASK-EAR-155: Store items Item/Type column truncates names

## Type

frontend

## Workstream

backoffice

## Priority

medium

## Created

2026-07-24

## Goal

On `admin/manage/store/items`, the Item/Type (Pass) and Item/Collection
(Avatar) columns lock at `w-[190px]` under `table-fixed`, and item names
use `truncate`, so operators cannot read full names despite empty space
in neighboring columns.

## Scope (Games-Labs-backoffice)

- `app/pages/admin/manage/store/items.vue` — Pass table Item/Type and
  Avatar table Item/Collection: widen column and show full names
  (wrap instead of ellipsis).

## Acceptance

- Column width stays at layout default (`w-[190px]`); do not widen.
- Truncated names show full text on mouse hover (`title` tooltip).
- Same behavior on Pass (Item/Type) and Avatar (Item/Collection).
- Table body height fits row content when few items (no empty min-height pad).
- When rows exceed max height (`min(58vh, 640px)`), table scrolls vertically.

## Non-goals

- Broken thumbnail URLs (separate issue).
- Packages store table (`packages/index.vue`) unless same symptom reported.

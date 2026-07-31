# TASK-EAR-175 — Player Detail table height matches Summary

## Type

feature

## Workstream

frontend

## Priority

medium

## Created

2026-07-31

## Context

On Player Detail (`Games-Labs-backoffice` Game / History tabs), the table
card sized to row content while the Summary sidebar kept its full stacked
height, leaving a visual gap. Operator asked for the table height to always
match Summary.

## Goal

On `lg+`, the History/Game table card bottom stays aligned with the Summary
panel bottom. Extra rows scroll inside the card.

## Scope

- Included: `Games-Labs-backoffice/app/pages/admin/manage/player/Detail/[id].vue`
- Excluded: Basic Info layout, API/data changes, mobile stacked layout

## Acceptance Criteria

- On viewport ≥1024px, Game and History table card bottom aligns with Summary bottom.
- When rows exceed that height, the table body scrolls inside the card.
- Below `lg`, no forced equal height (stacked layout).
- Pagination remains below the table card.

## Notes

- Admin layout scrollport makes pure flex/grid stretch unreliable; height sync
  uses `ResizeObserver` + `resize` against the Summary panel.

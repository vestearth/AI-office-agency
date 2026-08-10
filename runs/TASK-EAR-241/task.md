# TASK-EAR-241 — Manage Redemption → Tracking (queue #7)

## Type

feature

## Workstream

full-stack

## Priority

medium

## Created

2026-08-08

## Parent / Epic

- Parent: TASK-EAR-240
- Epic: Backoffice Manage full-connect queue

| Order | Task | Title |
| --- | --- | --- |
| … | TASK-EAR-235…240 | prior queue |
| 7 | **TASK-EAR-241** (this) | Redemption → Tracking (Figma only today) |

## Goal

Figma Manage → Redemption includes **Tracking** beside Library / Item. Backoffice has Library + Item pages/nav but **no Tracking menu or page**. Deliver Tracking (nav + page + API) or an operator-approved deferral that removes/hides the Figma expectation until ready.

## Verified current state (2026-08-08)

- Figma Manage IA `381:4618`: Redemption → Library / Item / Tracking.
- BO: `manage/redemption/library`, `manage/redemption/items` (+ edit); no Tracking link in `admin.vue`.
- TASK-EAR-236 covers Library/Item remaining demos only — Tracking explicitly out of that scope.

## Acceptance criteria

1. Product decision: what Tracking shows (fulfillment status, codes, shipments, etc.) vs Monitoring reports.
2. If building: Manage nav entry + dedicated page (not catch-all mock); backed by owned admin contract through gateway.
3. Contract discovery first — do not invent localStorage tracking.
4. shared-lib → owning service → **api-gateway staging** when proto lands.
5. Smoke or focused tests for MVP.

## Out of scope

- Closing Library/Item demos (TASK-EAR-236).
- Financial redemption monitor mock reports.

## Sources

- Figma Manage sidebar `381:4618`
- `Games-Labs-backoffice/app/layouts/admin.vue` (Redemption nav)
- `ai-dev-office/runs/TASK-EAR-236/task.md` (Tracking carved out)

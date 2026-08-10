# TASK-EAR-236 — Manage Redemption → Library / Item: finish remaining gaps (queue #2)

## Type

feature

## Workstream

full-stack

## Priority

high

## Created

2026-08-08

## Parent / Epic

- Parent: TASK-EAR-235 (queue predecessor — Game/Group)
- Epic: Backoffice Manage full-connect queue

| Order | Task | Title |
| --- | --- | --- |
| 1 | TASK-EAR-235 | Game → Game / Group full connect |
| 2 | **TASK-EAR-236** (this) | Redemption → Library / Item remaining gaps |
| 3 | TASK-EAR-237 | Promotion → Free Coin |
| 4 | TASK-EAR-238 | Payment Gateway |

## Goal

Library and Items are already mostly API-wired. Close remaining **demo / local-only** behaviors so Redemption admin matches Figma Manage → Redemption → Library / Item without fake persistence.

## Verified remaining gaps (source, 2026-08-08)

Connected already: redemptions, tags, redemption-items CRUD via AdminOrder; image upload path.

Still open:

1. **Items edit — Setting / code presentation** — marked demo; wire later (`redemption/items/edit/[id].vue`).
2. **Library arrange order** — list data from API but arrange order still in `localStorage` (`library/index.vue`).
3. Any other arrangement / code-import stubs still saying demo — re-audit on start.

## Out of scope

- **Redemption → Tracking** (exists in Figma Manage nav; **no BO menu/page yet**) — separate product slice, not this task unless operator expands scope.
- Payment Gateway, Free Coin, Game/Group.

## Acceptance criteria

1. No demo toast or local-only write presented as server success for Library/Item admin flows in scope.
2. Code presentation / Setting tab either persists via admin API or is honest read-only/disabled.
3. Arrange order either server-backed or clearly labeled local-only (product choice documented in the run).
4. Staging or focused test evidence for newly wired writes.
5. If new proto needed: shared-lib publish + Order + **api-gateway staging** bump.

## Sources

- Figma Manage IA (`381:4618` sidebar: Library / Item / Tracking)
- `Games-Labs-backoffice/app/pages/admin/manage/redemption/**`
- Gap Inventory Connected table (Redemption library/items)

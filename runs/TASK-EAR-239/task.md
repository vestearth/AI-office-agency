# TASK-EAR-239 — Manage VIP Level remaining Partial gaps (queue #5)

## Type

feature

## Workstream

full-stack

## Priority

medium

## Created

2026-08-08

## Parent / Epic

- Parent: TASK-EAR-238
- Epic: Backoffice Manage full-connect queue

| Order | Task | Title |
| --- | --- | --- |
| 1 | TASK-EAR-235 | Game → Game / Group full connect |
| 2 | TASK-EAR-236 | Redemption → Library / Item |
| 3 | TASK-EAR-237 | Promotion → Free Coin |
| 4 | TASK-EAR-238 | Payment Gateway |
| 5 | **TASK-EAR-239** (this) | VIP Level — close Partial gaps |
| 6 | TASK-EAR-240 | Leaderboard wire |
| 7 | TASK-EAR-241 | Redemption → Tracking |

## Goal

Operator asked what is still missing on Manage → **VIP Level** (`Partial`). Close remaining gaps so the page is Connected for admin CRUD, or document explicit deferrals with honest UI.

## Seed gaps (Gap Inventory — verify before coding)

From `knowledge-base/.../Backoffice API Gap Inventory.md` VIP level admin row (2026-06 wiring baseline):

1. **Delete level RPC** — list/create/update exist; delete not confirmed.
2. **Avatar collection master API** — wizard still needs a real collection master source.
3. **Column sort UI** — list enrichments landed; sort UX still missing.

**Not this task:** Player detail VIP Grant/Revoke / audit scopes (`PlayerVipLevelPanel`, `grant_vip` audit) — separate Partial track.

## Acceptance criteria

1. free-roam (or PM inventory) confirms or revises the three seed gaps against current User/BO source; write findings into this run.
2. Each confirmed gap is wired, deferred with operator note, or split to a follow-up TASK — no silent demo.
3. Delete (if built) goes through shared-lib → User → **api-gateway staging** bump.
4. No fake success toasts; focused tests or staging smoke for newly wired paths.

## Out of scope

- Player VIP Grant/Revoke envelope/audit Export production verification.
- Leaderboard / Tracking / Free Coin (other queue items).

## Sources

- Gap Inventory VIP level admin + Suggested Task Split item 5
- `Games-Labs-backoffice/app/pages/admin/manage/vip/`
- `Games-Labs-backoffice/app/components/VipLevelWizard.vue`
- User admin levels: `/api/v1/admin/levels`

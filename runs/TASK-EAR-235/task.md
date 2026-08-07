# TASK-EAR-235 — Manage Game → Game / Group: full connect (queue #1)

## Type

feature

## Workstream

full-stack

## Priority

high

## Created

2026-08-08

## Epic

Backoffice Manage full-connect queue (operator-ordered)

| Order | Task | Title |
| --- | --- | --- |
| 1 | **TASK-EAR-235** (this) | Game → Game / Group full connect |
| 2 | TASK-EAR-236 | Redemption → Library / Item remaining gaps |
| 3 | TASK-EAR-237 | Promotion → Free Coin |
| 4 | TASK-EAR-238 | Payment Gateway |

Do **not** start 236–238 until this task is `done` (or operator explicitly reorders).

## Goal

Eliminate remaining **demo / read-only stubs** under Manage → Game (Game list/edit) and Game → Group so admin writes persist through api-gateway to Games-Labs-Game (and related uploads) the same way Tags / VIP Level already do.

## Verified remaining gaps (source, 2026-08-08)

Already connected (do not re-open): list/detail/provider, tags New/Hot (EAR-224/228), VIP Level move+sync (EAR-229), production status, most group/level membership APIs.

Still open:

1. **Game edit — Special Pass tab** — UI exists; still demo-only (Field Lineage 2026-08-07).
2. **Game edit — Bet Limit tab** — UI exists; still demo-only.
3. **Game edit — Collection membership** — GetGameByID `collection` is display-only; membership writes stay on Game Group / category-games pages by design — confirm with operator whether "full connect" requires write-from-edit or honest read-only + deep-link is enough.
4. **Group edit — banner / 1:1 dropzones** — explicit demo copy; files become blob URLs only; save toast `"Group updated (demo)"` (`games/group/edit/[id].vue`).

## Out of scope

- Provider **service-level** status/image writes (no admin RPC yet — separate from Game/Group).
- Leaderboard, Invite, Payment Gateway, Free Coin (later queue items).
- Redesigning Figma; wire data + remove false demo success.

## Acceptance criteria

1. Inventory note in the run (or PR description) lists every remaining demo/stub on Game + Group pages and the decision for each: wired / honest read-only / deferred with TASK id.
2. No user-facing control on Game or Group admin pages claims a successful save when nothing was persisted.
3. Group banner (and any other group media dropzones in scope) either upload via existing `/admin/uploads/...` + persist through the group/category admin API, or are clearly disabled with "not available" (not a fake demo success).
4. Special Pass and Bet Limit tabs: either wired to a real contract or remain UI-only with no fake save — if contract missing, open a follow-up TASK and do not invent local persistence.
5. Focused tests or staging smoke for every newly wired write path; `GOWORK=off go build -mod=readonly` if Game/shared-lib/gateway change.
6. Backoffice: no new committed `replace` in go.mod (N/A for FE-only); if shared-lib bumped, gateway staging lane bump included.

## Plan notes for Dev

1. Re-audit `admin/games/**` and `admin/games/group/**` for `demo`, blob-only uploads, and toast stubs.
2. Prefer existing AdminGame / category / group RPCs and upload kinds before new proto.
3. Cross-service contract changes require shared-lib publish → service → **api-gateway staging** bump (see System Flow stage 2.5).

## Sources

- Figma Manage IA (sidebar on `381:4618`)
- `Games-Labs-backoffice/app/pages/admin/games/edit/[id].vue`
- `Games-Labs-backoffice/app/pages/admin/games/group/edit/[id].vue`
- `knowledge-base/.../Field Lineage — Games Categories Banners Splash.md`
- Queue decision: operator chat 2026-08-08

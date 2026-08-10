# TASK-EAR-237 — Manage Promotion → Free Coin (queue #3)

## Type

feature

## Workstream

full-stack

## Priority

medium

## Created

2026-08-08

## Parent / Epic

- Parent: TASK-EAR-236
- Epic: Backoffice Manage full-connect queue

| Order | Task | Title |
| --- | --- | --- |
| 1 | TASK-EAR-235 | Game → Game / Group full connect |
| 2 | TASK-EAR-236 | Redemption → Library / Item |
| 3 | **TASK-EAR-237** (this) | Promotion → Free Coin |
| 4 | TASK-EAR-238 | Payment Gateway |

## Goal

Figma Manage → Promotion includes **Free Coin** next to Coupon. Backoffice today has Coupon wired under Manage, but Free Coin is only a catch-all mock route (`manage/promotion/free-coins` via `useAdminPageData`) and is **not** in the Manage nav (a Free Coins report lives under Monitoring instead).

Deliver a real Manage → Promotion → Free Coin admin experience (nav + page + API), or an operator-approved decision that Free Coin stays out of Manage with Monitoring-only reporting.

## Verified current state (2026-08-08)

- Figma Manage sidebar: Promotion → Coupon, Free Coin.
- BO Manage nav: Promotion → Coupon only.
- Mock table seed: `mockFreeCoins` in `useAdminPageData.ts`.
- No `free_coin` / FreeCoin admin proto found in `shared-lib/proto` in this pass — **contract discovery required**.

## Acceptance criteria

1. Product decision recorded: Manage Free Coin admin CRUD vs report-only vs defer.
2. If building Manage Free Coin: nav entry under Manage → Promotion; dedicated page (not catch-all mock); real list/create/update (or documented MVP) through api-gateway.
3. No silent mock seed when `API_BASE_URL` + auth are present.
4. If new proto: shared-lib → owning service → **api-gateway staging** bump.
5. Smoke or focused tests for the chosen MVP.

## Out of scope

- Coupon (already Connected).
- Payment Gateway (EAR-238).
- Full marketing analytics under Monitoring unless reused as the chosen surface.

## Sources

- Figma Manage IA on `381:4618`
- `Games-Labs-backoffice/app/layouts/admin.vue`
- `Games-Labs-backoffice/app/composables/useAdminPageData.ts`

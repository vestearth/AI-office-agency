# TASK-EAR-224 — Wire Game Tags save + fix Coupon Level Access Pass labels

## Request

From QA (operator triage 2026-08-07):

1. **Out of scope (operator self-testing):** VIP Level unlock on Game edit
   Basic Info — do not change that path in this run.
2. **In scope — Game Tags:** Manage > Game > Edit > Collection & Tags >
   edit Tags (New / Hot / None) > Save — tag must persist after reload.
3. **In scope — Coupon Complimentary Pass detail:** Manage > Promotion >
   Coupon > Complimentary Item tab — Level Access Pass rows must show VIP
   level numbers/labels, not raw catalog UUIDs.

## Origin / evidence

Verified against current Backoffice source (not screenshots alone):

- `app/pages/admin/games/edit/[id].vue`: `tagKind` / `collectionPills` are
  local refs; `collectionPills` defaults to mock `['Top10','Slot new','New']`.
  `onPrimaryAction` only sends `{ level }` via `callUpdateGame`. The page
  never reads `is_new` / `is_hot` from GET.
- Backend already supports tags: `UpdateGameRequest` has optional `is_new` /
  `is_hot` (`shared-lib/.../admingame.proto`); Game service Update merges them
  with `NormalizeNewHot`. `GetGameByID` returns `is_new`, `is_hot`, and
  read-only `collection`.
- `app/composables/useAdminCouponApi.ts` `listSpecialItems` joins
  `detailFrom`/`detailTo` raw. For Level Access Pass those fields are VIP
  catalog UUIDs. Store Items already resolves via
  `formatPassDetailLabel(..., vipName)` in `app/utils/passDetail.ts`.

## Goal

Staff can set New/Hot/None on Game edit and have it persist through
`UpdateGame`. Coupon Complimentary Special Pass list shows Level Access Pass
detail as VIP labels (e.g. `VIP1-VIP5`), matching Store Items behavior.

## Scope

- Included: `Games-Labs-backoffice` only
  - Game edit: load/save Tags (`is_new`/`is_hot`); load `collection` for
    Group display (read-only — membership edits stay on Game Group pages)
  - Coupon API mapping: resolve Level Access Pass detail via
    `formatPassDetailLabel` + VIP catalog ids from `/admin/levels`
  - Focused tests
- Excluded: VIP Level unlock path (#1), Bet Limit / Special Pass tabs on
  game edit, backend/proto changes, Group membership write API

## Acceptance criteria

1. Opening Game edit loads Tags radio from the game's `is_new` / `is_hot`.
2. Editing Tags and Save calls `UpdateGame` with the matching `is_new` /
   `is_hot` (and still sends VIP `level` as today); after reload the selected
   tag is unchanged.
3. Group pills show GET `collection` (or empty), not the hardcoded mock list;
   removing a group pill does not claim a game was deleted and does not
   pretend membership was persisted (read-only display is acceptable).
4. Coupon Complimentary Special Pass list formats Level Access Pass detail
   with VIP labels via catalog id resolution; Point Multiplier detail still
   renders via `formatPassDetailLabel` (e.g. `Point x N`).
5. Focused tests cover tagKind ↔ flags helpers and special-item detail
   mapping; existing `npm test` stays green.

## Suggested ownership

`dev` — single Backoffice repo, existing helpers/APIs, no contract change.

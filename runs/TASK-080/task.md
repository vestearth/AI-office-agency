# TASK-080: Wire Redemption Items + Brand Detail to API (frontend only)

## Short name
`redemption-items-frontend-wiring`

## Type
feature

## Priority
medium

## Parent / Epic
- Parent: `TASK-079`
- Epic: Admin Redemption Management

## Status

Done. Subtasks 1–4 implemented, typecheck-clean, committed and pushed; upload
verified working end to end by the user. Reviewer approved (in_review → done).
Item edit lives in TASK-081 (dev-2, now DONE — B1 shipped); backend gaps B2–B7 below
remain handed off to the backend owner. Smoke-phase extras delivered along the way: error-variant toast,
fail-fast upload, per-kind upload destinations, instant local image previews, and a
typed-input sweep for stepper controls (incl. leaderboard edit).

## Background

`admin/manage/redemption/library/index.vue` (Brand/Tag) is wired (TASK-079). The
rest of the redemption domain is still mock (0 `$fetch`):

- `redemption/items.vue` — e-voucher list
- `redemption/items/create.vue` — create item (large form)
- `redemption/items/edit/[id].vue` — edit item
- `redemption/library/brand/[id].vue` — brand detail (items under a brand)

The Order admin API already provides item endpoints (`POST /redemption-item`,
`GET /redemption-items`, `GET /redemption-items/{id}`) and the `/uploads` image
endpoint from TASK-079. This task wires the frontend to those, with client-side
workarounds where the API is missing a filter, and gates anything that needs a
not-yet-existing endpoint.

## Scope

### Target services

| Service | Role |
| --- | --- |
| `Games-Labs-backoffice` | Wire items list/create + brand detail to existing endpoints; reuse `/uploads`. |
| `ai-dev-office` | Task status, dev handoff, backend handoff list. |

### In scope (frontend, existing endpoints only)

- `items.vue` → `GET /api/v1/admin/redemption-items` (paginated) + pending/error.
- `items/create.vue` → `POST /api/v1/admin/redemption-item`; reuse `useImageUpload`
  for `thumbnail_url`/`logo_url` (real URLs only, no data URLs).
- `library/brand/[id].vue` → brand header + its items via `GET /redemption-items`
  filtered by `redemption_id` CLIENT-SIDE (interim until B3).
- Brand list: add a reachable edit path using the existing
  `POST /api/v1/admin/redemptions/{id}` (submitBrand already implemented).
- Brand `Item` count (evoucher): derive from the items list CLIENT-SIDE (interim).
- `items/edit/[id].vue` → prefill via `GET /redemption-items/{id}`; Save wired to
  `POST /redemption-items/{id}` (B1 — shipped in TASK-081).
- Optional: tag↔redemption picker in the tag modal (existing endpoints already
  accept `redemptionIds`/`tagIds`; no backend needed).

### Explicitly out of scope

- Any new/changed backend endpoint or proto/migration (see Backend handoff).
- `total_redeem` real values (no source).
- Server-side item filtering/pagination beyond what exists.

## Backend handoff (OTHER OWNER — do NOT implement in this task)

These block or degrade the frontend; listed for the backend owner with suggested
contracts. Frontend will gate/worked-around until these land.

| ID | Need | Suggested contract | Unblocks |
| --- | --- | --- | --- |
| B1 | Update a redemption item — **✅ DONE (shipped in TASK-081, 2026-06-11)** | `POST /api/v1/admin/redemption-items/{id}` — body = `CreateRedemptionItemRequest` + `id`; `UpdateRedemptionItem` rpc live on origin/main | `items/edit/[id].vue` Save |
| B6 | `RedemptionItem`/`CreateRedemptionItemRequest` missing `type` and `total_quota` | add the fields to the proto, or product drops the "Type"/"Total Quota" inputs | items list/create (Type + Total Quota are collected but dropped) |
| B7 | Multi-tier player quota | UI has 1 quota tier; proto has `player_quota_condition_1..3` / `limit_day_per_player_1..3`. Only tier 1 is sent — confirm intended mapping | item create quota |
| B2 | Delete a redemption item | `DELETE /api/v1/admin/redemption-items/{id}`; add `DeleteRedemptionItem` rpc | item delete action |
| B3 | Filter items by brand/tag | Add `redemption_id` (and `tag_id`) to `ListRedemptionItemsRequest` | brand detail items + per-brand Item count (drop client-side filtering) |
| B4 | Persist arrange order | Add `sort_order` to `UpdateRedemptionsRequest`/`UpdateTagsRequest`, or a `/reorder` endpoint | Arrange panel persistence (currently localStorage only) |
| B5 | Total redeemed metric | A redeemed-count source/field per redemption (tables dropped `total_redeem` in migration 015) — aggregate from orders/usage | "Total Redeemed" column (currently "-") |

Note: tag↔brand linking is NOT a backend item — `CreateTags`/`UpdateTags` already
accept `redemption_ids` and `CreateRedemptions` accepts `tag_ids`.

## Acceptance criteria

- [x] `items.vue` lists redemption items from the API with pending/error states.
- [x] The create modal (in `items.vue`) creates an item via `POST /redemption-item`;
  thumbnail/logo go through `/uploads` and are stored as real URLs (no data URL);
  brand picks a real `redemption_id`.
- [x] `library/brand/[id].vue` shows the brand and its items (client-side
  `redemption_id` filter).
- [x] Brand edit is reachable from the UI (list Manage → detail Basic Info) and
  persists via the redemptions API; logo uploads through `/uploads`.
- [~] `items/edit/[id].vue` — moved to TASK-081 (dev-2) with the new update endpoint.
- [ ] No backend/proto/migration changes are made in this task.
- [ ] Backend dependencies are captured (B1–B5) for the backend owner.

## Subtasks

| Order | ID | Agent | Description | Status |
| --- | --- | --- | --- | --- |
| 1 | `items-list` | `dev` | Wire `items.vue` to `GET /redemption-items` (client-side brand/tag name join) | done |
| 2 | `item-create` | `dev` | Wire the create modal in `items.vue` → `POST /redemption-item` + `/uploads` (items/create.vue is dead) | done |
| 3 | `brand-detail` | `dev` | Wire `library/brand/[id].vue` (client-side item filter) | done |
| 4 | `brand-edit-entry` | `dev` | Brand edit via existing update API (list Manage → detail Basic Info) | done |
| ~~5~~ | `item-edit-readonly` | — | Item edit — **moved to TASK-081 (dev-2)** who owns B1 + edit wiring | dropped |

## Assignment

- Primary: `dev`
- Parallel: `false`

Reason: sequential frontend wiring on one domain; later pages reuse types/helpers
from earlier ones.

## Next action

Closed. Follow-ups live elsewhere: TASK-081 (item edit, dev-2) and the backend
handoff list B1–B7 above. Residual ops check: CloudFront must serve uploaded
objects in list views after reload (bucket policy / OAC on the public/ prefixes).

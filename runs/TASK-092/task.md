# TASK-092: B5 — Total Redeemed (+ Item count) in Library via client-side item rollup

## Short name
`redemption-library-total-redeemed-agg`

## Type
feature

## Priority
medium

## Parent / Epic
- Parent: `TASK-080`
- Epic: Admin Redemption Management

## Status

In progress. Closes the visible half of gap **B5**: the library list's
"Total Redeemed" column shows `"-"` because `Redemption`/`Tag` have no redeemed
field. Backend added `total_redeemed` (+ `quota_used`) on **`RedemptionItem`** only
(order.proto:165) — per-item, not per-brand/tag. Per the user's choice, aggregate
client-side: load `ListRedemptionItems`, sum `total_redeemed` and count items
grouped by `redemptionId` (brand) and by each `tagIds` entry (tag), then fill the
Total Redeemed column and fix the Item count.

(Note: the manual Gift `total_quota` request-contract work is a separate backend
task, TASK-091.)

## Scope

### Affected files

| Path | Action | Description |
| --- | --- | --- |
| `app/pages/admin/manage/redemption/library/index.vue` | modify | Fetch redemption-items, build per-brand/per-tag rollups (redeemed + item count), render in the Total Redeemed + Item columns. |

## Approach

- Add `GET /api/v1/admin/redemption-items` (page.limit large) on mount alongside the
  brand/tag fetches.
- Build `redeemedByBrand` / `redeemedByTag` maps: `{ redeemed, items }` keyed by id.
- `rowRedeemed(row)` / `rowItemCount(row)` overlay the maps onto the rendered rows
  (fall back to the row's own value when the rollup is missing) — keyed by activeTab.
- All-time totals (the field is a single counter; not date-range filtered). Loaded
  once on mount (not on search — rollups are keyed by id).

## Out of scope / notes

- Per-brand/tag redeemed remains a client-side rollup until backend exposes an
  aggregate (or B3 `redemption_id` filter); capped at the fetch page.limit.
- `quota_used` not surfaced here.

## Acceptance Criteria

- [ ] Brand tab: Total Redeemed = sum of items' `total_redeemed` for that brand; Item = item count.
- [ ] Collection Tag tab: same, grouped by tag membership.
- [ ] Falls back to "-" / existing value when no rollup (e.g., fetch fails).
- [ ] `nuxi typecheck` clean.

## Verification

- `cd Games-Labs-backoffice && npx nuxi typecheck`.
- Manual (real token): library Total Redeemed shows real numbers; Item counts match.

## Assignment

- Primary: `dev`
- Parallel: `false`

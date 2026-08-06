# TASK-EAR-216: My E-Vouchers — return itemName and brandName on owned list

## Type

feature

## Workstream

backend

## Priority

low

## Created

2026-08-06

## Goal

Let Redeem > My E-Vouchers render real labels from
`GET /api/v1/my-redemption-items` without client-side joins against the browse
catalog.

Mobile reported QA showing placeholder title `"Redeemed E-Voucher"` and raw
UUIDs where brand/item text should be, because the owned-list contract today
has no display names. Matching `redemptionItemId` / `categoryIds` against
`GET /api/v1/redemptions` is unreliable: that catalog filters to active,
in-window, not-fully-redeemed items, while owned vouchers often fall outside
those filters.

## Current source evidence

- `shared-lib/proto/orderpb/order.proto` — `UserRedemptionItem` fields are
  ownership/code oriented (`id`, `user_id`, `redemption_item_id`,
  `redemption_code_id`, `code`, `category_ids`, `point_spent`, `valid_until`,
  timestamps, `is_favorite`). No `item_name` / `brand_name`.
- `Games-Labs-Order/internal/core/handlers/orderhdl/grpc.go`
  `modelUserRedemptionItemToPB` maps only those fields.
- `ListUserRedemptionItems` already `JOIN redemption_items ri` (and favorites);
  `category_ids` is currently sourced from `ri.tag_ids`, and `valid_until` from
  `ri.end_date`. Brand lives on parent `redemptions.name` via `ri.redemption_id`;
  item title lives on `ri.name`.
- Public `ListRedemptions` uses `Status=active`, `OnlyWithinWindow=true`,
  `ExcludeFullyRedeemed=true` — so client-side ID resolution will keep failing
  for many owned rows. Do not ask Mobile to keep joining the catalog.
- api-gateway registers `orderpb.RegisterOrderServiceHandlerFromEndpoint`; the
  HTTP route already exists. Additive response fields need a published
  shared-lib bump so gateway Swagger/types refresh — no new route.

## Confirmed product / Mobile ask

Mobile asked (2026-08-06, not urgent) for `itemName` and `brandName` on
`GET /api/v1/my-redemption-items`. Treat that as the committed display contract.

Field semantics (lock these):

| JSON field | Proto field | Source |
| --- | --- | --- |
| `itemName` | `item_name` | `redemption_items.name` for `redemption_item_id` |
| `brandName` | `brand_name` | parent `redemptions.name` via `redemption_items.redemption_id` |

Empty string when the join source is missing (should be rare given the existing
inner join on `redemption_items`). Do not invent client-side fallbacks in the
API.

## Committed scope

### shared-lib (Gate 1)

- Extend `orderpb.UserRedemptionItem` with additive:
  - `string item_name = <next>;`
  - `string brand_name = <next>;`
- Regenerate protobuf / gRPC-gateway / Swagger via the shared-lib buf/make path.
  Do not hand-edit generated files.
- Stop for operator publish of `shared-lib`. No consumer bumps until publish.

### Games-Labs-Order (Gate 2, after publish)

- Bump `github.com/SparqLab/shared-lib` to the operator-published version.
  Run `go mod tidy` in the service directory; commit `go.mod` + `go.sum`
  together; no committed `replace`.
- Enrich `models.UserRedemptionItem` + `userRedemptionItemSelectColumns` /
  scan path to select `ri.name` and parent brand name (join `redemptions`).
- Map both fields in `modelUserRedemptionItemToPB` so every producer of
  `UserRedemptionItem` benefits (`ListMyRedemptionItems` and
  `RedeemRedemptionItem` response).
- Keep pagination, ordering, auth scoping (`callerUserID`), codes, points,
  `validUntil`, `categoryIds`, and `isFavorite` behavior unchanged.
- Add focused repository/handler tests that assert owned-list rows expose
  non-empty `itemName` / `brandName` from joined sources (table-driven;
  cover missing brand parent as empty string if reachable in fixtures).
- Verify `GOWORK=off go build -mod=readonly ./...` in Order.

### api-gateway (Gate 3, after same publish)

- Bump to the **same** published shared-lib version so OpenAPI/`orderpb`
  types include the new fields on the existing route.
- No new handler registration expected; verify build with
  `GOWORK=off go build -mod=readonly ./...` and no `replace`.

## Out of scope (deferred)

- `thumbnailUrl` / `logoUrl` on owned list (nice-to-have icon fix; Mobile did
  not ask in this notify).
- Exposing internal `UserRedemptionItem.Status` on the public proto (UI pills
  today are client-derived; separate contract if Product wants server status).
- Changing catalog `ListRedemptions` filters or asking Mobile to keep joining
  browse data.
- Prod promotion / Mobile UI wiring after staging — separate evidence.

## Sequential publication gates

1. Implement and verify shared-lib contract + generated artifacts only.
2. Stop for operator to publish `shared-lib` and supply the version.
3. Bump + implement enrichment in `Games-Labs-Order`; verify without replace.
4. Bump the same version in `api-gateway`; verify build/Swagger refresh.
5. Staging authenticated smoke of `GET /api/v1/my-redemption-items` is later
   operator evidence — source/tests alone do not prove the environment.

## Acceptance criteria

- [ ] `orderpb.UserRedemptionItem` includes additive `item_name` and
      `brand_name`; generated artifacts updated via buf/make (no hand-edits).
- [ ] Authenticated `GET /api/v1/my-redemption-items` returns `itemName` and
      `brandName` on every `items[]` entry from the joined catalog sources
      above (not from client-side catalog matching).
- [ ] `POST /api/v1/redemptions/{id}/redeem` response `item` carries the same
      two fields when the redeem path returns `UserRedemptionItem`.
- [ ] Existing owned-list fields and auth scoping remain unchanged; no new
      query params; no committed `replace` in Order or api-gateway.
- [ ] Focused Order tests cover the enrichment; Order and api-gateway
      `go build -mod=readonly ./...` pass after the published bump.
- [ ] Mobile can drop the catalog join for My E-Vouchers labels once staging
      serves the new fields (handoff note in agent output).

## Risks

- **Shared-lib publish lag** — Order/gateway must wait; mitigate with hard
  Gate 1 stop and no local replace.
- **Wrong brand source** — brand is `redemptions.name`, not `tag_ids` /
  `categoryIds`; acceptance criteria and SQL join must use the parent
  redemption row.
- **Deleted parent brand** — if a redemption row is missing, return empty
  `brandName` rather than failing the owned list (prefer LEFT JOIN on
  `redemptions` while keeping the existing `redemption_items` join).

## Assignment

- Primary: `dev-2` (cross-repo contract + publish/bump gates)
- Parallel: false
- Start at Gate 1 only (`shared-lib`)

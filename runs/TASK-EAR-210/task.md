# TASK-EAR-210: User-scoped favorite state for redemption items

## Type

feature

## Workstream

backend

## Priority

medium

## Created

2026-08-05

## Goal

Support the heart-icon UX consistently on the redemption catalog and owned
voucher screens. The authenticated user can explicitly set or clear favorite
state for an underlying redemption item, and both public read APIs return that
state as `isFavorite`.

Affected public APIs:

- `GET /api/v1/redemptions`
- `GET /api/v1/my-redemption-items`
- New `GET /api/v1/favorite-redemption-items`
- New idempotent mutation for `{redemption_item_id}` favorite state

## Current source evidence

- `shared-lib/proto/orderpb/order.proto` defines both GET routes, but
  `RedemptionItem` and `UserRedemptionItem` have no `is_favorite` field.
- `orderpb.OrderService` has no favorite mutation RPC.
- `Games-Labs-Order` has no favorite model, repository method, or persistence
  table/migration.
- The api-gateway authenticates `/api/v1/*` requests and injects the trusted
  caller id into gRPC metadata. The mutation must use that identity; it must not
  accept a client-controlled `user_id`.
- Existing `status` on `RedemptionItem` means active/inactive and must remain
  independent from favorite state.

## Confirmed product contract

Mobile confirmed on 2026-08-05 that favorite is item-level: one row per
authenticated user and `redemption_item_id`. Duplicate owned vouchers for the
same item must all return the same `isFavorite` value.

Per the Figma behavior, a favorite relation survives when its item becomes
fully redeemed, inactive, or expired. Such an item may disappear from the
normal Redeem listing but must remain visible on the Favorites page until the
user unfavorites it (or the underlying item is deleted).

The Favorites API must return an explicit, stable availability value so Mobile
does not duplicate backend business rules. Initial values:

- `available`
- `upcoming`
- `expired`
- `inactive`
- `fully_redeemed`

Unavailable favorites remain readable and unfavoritable, but the redeem action
must remain disabled/rejected under the existing redeem-time rules. When more
than one condition applies, use deterministic precedence: `inactive`,
`expired`, `upcoming`, `fully_redeemed`, then `available`.

## Committed scope

### shared-lib

- Extend `orderpb.RedemptionItem` with an additive `bool is_favorite` field.
- Extend `orderpb.UserRedemptionItem` with an additive `bool is_favorite` field.
- Add an explicit item availability enum/field to the shared
  `RedemptionItem` response shape.
- Add an authenticated, paginated Favorites list RPC, proposed as:

  ```text
  GET /api/v1/favorite-redemption-items
  ```

  It returns the favorited underlying `RedemptionItem` records, including
  inactive, expired, upcoming, and fully redeemed items.
- Add an authenticated, idempotent RPC/HTTP mapping to set the desired state,
  proposed as:

  ```text
  PATCH /api/v1/redemptions/{redemption_item_id}/favorite
  { "isFavorite": true }
  ```

- The request contains `redemption_item_id` and `is_favorite`, but no `user_id`.
- Regenerate protobuf, gRPC-gateway, and Swagger artifacts. Do not manually edit
  generated files.

### Games-Labs-Order

- Add a migration for a user/item favorite relation with uniqueness on
  `(user_id, redemption_item_id)`, a foreign key to `redemption_items`, and
  timestamps. Do not add a cross-service foreign key for `user_id`.
- Add narrowly owned model/repository/service/handler support for setting or
  clearing favorite state.
- Derive the user id from trusted gRPC metadata with the existing
  `callerUserID` path.
- Enrich both list paths without N+1 queries:
  - catalog `RedemptionItem.is_favorite`
  - owned `UserRedemptionItem.is_favorite`, derived from its underlying
    `redemption_item_id`
- Add a user-scoped, paginated Favorites repository/handler path that joins the
  favorite relation to `redemption_items` without the normal active/date/quota
  visibility filters and returns the explicit availability value.
- Keep the normal catalog browse-eligible. In addition to its current
  active/window filters, exclude items where
  `total_quota > 0 AND total_redeemed >= total_quota`; the dedicated Favorites
  path still returns them as `fully_redeemed`.
- Keep redeem-time validation, quota fields, voucher codes, and owned-voucher
  pagination/order unchanged.
- Add focused repository/handler tests, including user isolation and repeated
  set/clear requests.

### api-gateway

- After shared-lib is published, bump the dependency and register/expose the
  generated Favorites GET and PATCH routes through the existing Order handler.
- Preserve authenticated caller metadata propagation.
- Run `go mod tidy` and commit `go.mod` plus `go.sum` together. No local
  `replace` directive may be committed.

## Sequential publication gates

1. Implement and verify the `shared-lib` contract/generated artifacts only.
2. Stop for the operator to publish `shared-lib`.
3. Bump the published version in `Games-Labs-Order`, implement the migration and
   behavior, then verify it without a committed local replace.
4. Bump the same published version in `api-gateway` and verify route exposure.
5. Deployment and authenticated staging smoke are separate, later evidence;
   source/tests alone do not prove the target environment is updated.

## Acceptance criteria

- [x] Mobile confirmed favorite is scoped to the underlying
      `redemption_item_id`, not an individual owned voucher row.
- [ ] Authenticated `GET /api/v1/redemptions` returns `isFavorite` on every
      `redemptionItems[]` entry; default is `false` when no relation exists.
- [ ] Authenticated `GET /api/v1/my-redemption-items` returns `isFavorite` on
      every `items[]` entry using its `redemptionItemId`.
- [ ] Authenticated `GET /api/v1/favorite-redemption-items` is user-scoped and
      paginated, and returns only that caller's favorited underlying items.
- [ ] The Favorites response retains inactive, expired, upcoming, and fully
      redeemed items with `isFavorite: true` and an explicit availability value.
- [ ] Normal `GET /api/v1/redemptions` excludes inactive, out-of-window, and
      fully redeemed items; changing normal-list visibility never deletes the
      favorite relation.
- [ ] Duplicate owned voucher instances with the same `redemptionItemId` always
      return the same `isFavorite` value.
- [ ] The mutation sets the requested boolean explicitly and is idempotent:
      retrying the same request leaves the same state.
- [ ] A user cannot read or mutate another user's favorite state by supplying a
      user id in query/body/header input.
- [ ] Favorite states are isolated between users for the same redemption item.
- [ ] Setting `true`, setting `true` again, setting `false`, and setting `false`
      again all succeed with deterministic final state.
- [ ] An unknown `redemption_item_id` returns the existing structured not-found
      error convention and does not create an orphan favorite.
- [ ] Existing catalog search/filter/pagination and owned-voucher
      pagination/order remain unchanged apart from the intentional
      fully-redeemed visibility rule.
- [ ] Proto/generated-artifact checks and focused Order tests pass.
- [ ] `GOWORK=off go build -mod=readonly ./...` passes in both consumer repos
      after the published shared-lib bump; no committed `replace` remains.
- [ ] An authenticated gateway smoke proves set `true` -> both GETs show true ->
      set `false` -> both GETs show false in the target environment before
      claiming deployment complete.

## Risks and mitigations

- **Wrong ownership key:** favoriting an owned voucher id would make duplicate
  vouchers inconsistent. Gate implementation on the item-level product decision.
- **Toggle retry race:** a toggle-style POST can invert state twice. Accept the
  desired boolean and implement idempotent set semantics.
- **Contract rollout mismatch:** older gateway artifacts can silently omit new
  proto fields/routes. Publish and bump shared-lib sequentially in every
  consumer.
- **Query amplification:** per-item favorite lookups would create N+1 behavior.
  Use a set-based join/exists strategy in both repository list queries.
- **Favorites derived from normal browse:** reusing the active/window-filtered
  browse query would make unavailable favorites disappear. Implement a dedicated
  user-scoped query and share only safe mapping/status helpers.
- **Client-derived availability drift:** asking Mobile to combine status, dates,
  and quota counters would duplicate business rules. Return one explicit stable
  availability value from the backend.
- **Identity spoofing:** never trust request `user_id`; use authenticated caller
  metadata and cover it with handler tests.

## Out of scope

- Mobile UI implementation or heart-icon visual behavior.
- Custom sorting/filtering within the Favorites page beyond deterministic
  pagination/order.
- Favorite state for brands, tags, gifts outside redemption items, or individual
  voucher instances.
- Commit, push, PR, merge, deployment, or production data mutation in the PM
  phase.

## Assignment

- Primary: `dev-2`
- Parallel: `false`
- Reason: cross-repository protobuf, generated artifacts, migration, authenticated
  user-scoped persistence, and publish/bump gates must be delivered sequentially.

# TASK-EAR-251 — Caller-scoped redemption eligibility and visibility

## Type

feature

## Workstream

backend

## Priority

medium

## Created

2026-08-11

## Parent / Epic

- Parent: `TASK-EAR-210`
- Epic: Redemption catalog and Favorites contract

## Goal

Make the redemption catalog and Favorites responses explain whether the
authenticated caller can redeem an item under backend item/player quota rules,
without asking Mobile to infer business rules from raw counters or free-text
errors. Apply the Design-confirmed visibility behavior for lifetime-limit,
daily-limit, and globally unavailable items.

Affected public APIs:

- `GET /api/v1/redemptions`
- `GET /api/v1/favorite-redemption-items`
- `POST /api/v1/redemptions/{redemption_item_id}/redeem`

## Current source evidence

- `shared-lib/proto/orderpb/order.proto` already exposes
  `RedemptionItem.availability` as field 33, but documents that normal browse
  may leave it empty. There is no caller-specific eligibility object,
  machine-readable eligibility reason, or `nextEligibleAt`.
- `Games-Labs-Order/internal/core/handlers/orderhdl/grpc.go` filters normal
  browse to active, in-window, not-fully-redeemed items and uses optional
  caller metadata only for `isFavorite` enrichment.
- `Games-Labs-Order/internal/core/repositories/redemption.go` authoritatively
  enforces total item quota, one-time/lifetime player quota, per-player daily
  quota, and all-player item daily quota inside the locked redeem transaction.
  Daily reset is `00:00 Asia/Bangkok`.
- The three requested player/daily quota failures all use generic status code
  `1002` and differ only by free-text description, which is not a stable Mobile
  routing contract.
- The gateway authenticates `/api/v1/*` and forwards token-derived `userid`
  metadata, but the current redeem handler still passes protobuf request
  `user_id` to the service instead of using `callerUserID(ctx)`.
- `redemption_item_favorites` currently has `ON DELETE CASCADE`; an underlying
  hard delete removes the favorite relation. Tombstone retention does not
  exist.

## Confirmed Product / Mobile contract

Confirmed on 2026-08-11:

1. After a successful redeem causes the caller to reach the lifetime/total
   player limit, remove the item from the Primary/main Redeem listing.
2. If that item was already favorited, retain it on Favorites, disabled and
   dimmed, with the label `Limit Reached`, until the player unfavorites it.
3. Keep global item `availability` separate from caller-specific
   `redemptionEligibility` in the API response.
4. `canRedeemNow` covers backend item/player quota eligibility only. It does
   not include Point balance; Mobile owns the Point-balance check.
5. Retain favorited items across inactive, upcoming, expired,
   fully-redeemed, lifetime-limit, and daily-limit states until the player
   unfavorites them.
6. Player-daily and item-daily limits remain visible on Primary and Favorites,
   disabled, and become eligible again at the next `00:00 Asia/Bangkok`.

Hard-deleted/unresolvable items are intentionally excluded from the retention
promise for this task: current cascade behavior remains unchanged unless
Product separately requests tombstones.

## Public response contract

Add an optional nested response field to `orderpb.RedemptionItem` using the
next free field number (currently proposed as field 34):

```proto
message RedemptionEligibility {
  bool can_redeem_now = 1;
  string reason_code = 2;
  google.protobuf.Timestamp next_eligible_at = 3;
}

message RedemptionItem {
  // Existing fields 1-33 remain unchanged.
  RedemptionEligibility redemption_eligibility = 34;
}
```

Stable `reasonCode` wire values:

- `PLAYER_TOTAL_LIMIT_REACHED`
- `PLAYER_DAILY_LIMIT_REACHED`
- `ITEM_DAILY_LIMIT_REACHED`

Semantics:

- Eligible now: `canRedeemNow: true`; omit/empty `reasonCode` and
  `nextEligibleAt`.
- Player lifetime/total limit: `canRedeemNow: false`, reason
  `PLAYER_TOTAL_LIMIT_REACHED`, no `nextEligibleAt`.
- Player daily limit: `canRedeemNow: false`, reason
  `PLAYER_DAILY_LIMIT_REACHED`, `nextEligibleAt` at the next Bangkok midnight.
- Item daily limit: `canRedeemNow: false`, reason
  `ITEM_DAILY_LIMIT_REACHED`, `nextEligibleAt` at the next Bangkok midnight.
- When global `availability` is not `available`, return
  `canRedeemNow: false`; Mobile routes the global state from `availability`,
  so quota `reasonCode` may remain empty.
- Deterministic precedence is global availability first, then
  `PLAYER_TOTAL_LIMIT_REACHED`, `PLAYER_DAILY_LIMIT_REACHED`,
  `ITEM_DAILY_LIMIT_REACHED`, then eligible.
- Eligibility is an advisory list snapshot. The locked redeem transaction
  remains authoritative when state changes between GET and POST.

## Visibility contract

| Global availability | Caller reason | Primary | Favorites |
| --- | --- | --- | --- |
| `available` | none | visible/enabled | visible/enabled |
| `available` | `PLAYER_TOTAL_LIMIT_REACHED` | hidden | visible, disabled/dimmed, `Limit Reached` |
| `available` | `PLAYER_DAILY_LIMIT_REACHED` | visible/disabled | visible/disabled, `Daily Limit Reached` |
| `available` | `ITEM_DAILY_LIMIT_REACHED` | visible/disabled | visible/disabled, `Daily Limit Reached` |
| `fully_redeemed` | none | hidden | visible/disabled, `Fully Redeemed` |
| `inactive`, `expired`, or `upcoming` | none | hidden | visible with the global availability state |

Primary lifetime filtering must happen before `LIMIT/OFFSET` and count
calculation; hiding rows after pagination would return incorrect page totals
and short pages.

## Committed scope

### shared-lib

- Add `RedemptionEligibility` and additive field 34 on `RedemptionItem`.
- Document exact JSON wire values, null/omission behavior, precedence, and the
  fact that Point balance is excluded.
- Add stable Order business errors for the three confirmed quota reasons so
  authoritative POST failures do not require parsing description text.
- Regenerate protobuf, gRPC, grpc-gateway, and Swagger artifacts; never edit
  generated files manually.
- Verify the shared contract, then stop for operator publish before changing
  consumers.

### Games-Labs-Order

- Bump to the operator-published shared-lib version and run `go mod tidy`.
- Require authenticated caller identity for personalized catalog eligibility.
- Change `RedeemRedemptionItem` to use trusted `callerUserID(ctx)`; retain the
  wire `user_id` field for compatibility but ignore it. Preserve idempotency
  behavior using the trusted caller id.
- Filter lifetime-limit items from Primary at the repository query/count layer.
- Retain those items in the existing Favorites query and populate their caller
  eligibility.
- Compute player lifetime, player daily, and item daily quota state with
  set-based/batched queries for the returned page; do not add per-item
  eligibility queries.
- Populate normal browse `availability` as `available`; keep existing Favorites
  global availability computation.
- Use one captured evaluation time and the existing Bangkok-day rule to derive
  `nextEligibleAt` consistently.
- Reuse the locked POST enforcement as authority and return stable errors for
  the three confirmed reasons.
- Inspect `EXPLAIN` for the new caller/day query shapes. Add a normal migration
  with narrowly scoped composite indexes only if current indexes do not support
  the accepted query plan; do not add an index speculatively.
- Add focused handler, service, repository, and integration tests.

### api-gateway

- After shared-lib publication, bump to the same version and run `go mod tidy`.
- Preserve authenticated caller metadata propagation and ensure the new nested
  field survives REST JSON serialization.
- No new HTTP route is required; this is an additive response-contract bump on
  existing generated Order routes.

## Sequential delivery gates

1. Implement and verify shared-lib contract, generated artifacts, and stable
   error definitions only.
2. Stop for the operator to publish shared-lib.
3. Bump Games-Labs-Order to the published version, implement caller-scoped
   behavior/querying, and verify unit/integration tests.
4. Bump api-gateway to the same published version and verify REST exposure.
5. Review the complete cross-repo change before merge.
6. Deploy backend before Mobile adoption and run authenticated staging
   acceptance. Source/tests are not deployment proof.

## Acceptance criteria

- [ ] `RedemptionItem` has additive `redemptionEligibility` with the three
      confirmed stable reason values and documented omission semantics.
- [ ] Existing proto field numbers, routes, fields, and JSON names remain
      backward compatible.
- [ ] Authenticated normal browse always returns global
      `availability: "available"` for emitted items and a populated caller
      eligibility object.
- [ ] A caller who has exhausted `One-time use only` no longer sees that item
      on Primary after refresh; the Primary count and pagination exclude it.
- [ ] The same lifetime-limited item remains on Favorites when favorited, with
      `isFavorite: true`, `availability: "available"`,
      `canRedeemNow: false`, reason `PLAYER_TOTAL_LIMIT_REACHED`, and no
      `nextEligibleAt`.
- [ ] Player-daily and item-daily limited items remain on Primary and Favorites,
      return the correct distinct reason, and return the exact next
      `00:00 Asia/Bangkok` timestamp.
- [ ] At the Bangkok day boundary, both GET eligibility and POST enforcement
      transition consistently; boundary tests cover before/at/after midnight.
- [ ] Inactive, upcoming, expired, and fully redeemed favorites remain visible
      and are routed by global `availability`, independently of caller reason.
- [ ] `canRedeemNow` does not query or incorporate Point balance.
- [ ] Eligibility enrichment is set-based/batched and introduces no per-item
      eligibility query; integration tests cover a multi-item page.
- [ ] GET and POST both derive the player from trusted caller metadata. A
      mismatched body `user_id` cannot evaluate, debit, or redeem for another
      player.
- [ ] Redeem POST returns distinct stable business errors for player total,
      player daily, and item daily quota failures while preserving refund and
      idempotency behavior.
- [ ] Hard-deleting an item keeps the current cascade behavior; tombstone
      retention is not introduced.
- [ ] Old clients tolerate the additive response, and Mobile tolerates the new
      field being absent until backend rollout completes.
- [ ] Focused proto checks, Order unit/integration tests, and gateway tests pass.
- [ ] After each published dependency bump, `go.mod` and `go.sum` are updated
      together, no `replace` is committed, and
      `GOWORK=off go build -mod=readonly ./...` passes in both consumers.
- [ ] Authenticated staging smoke proves all visibility/reason combinations and
      a successful redeem followed by Primary removal before deployment is
      claimed complete.

## Risks and mitigations

- **Incorrect pagination:** filtering lifetime-limited rows after paging yields
  short pages and wrong totals. Apply the caller filter in both list and count
  SQL before pagination.
- **N+1 or expensive counts:** three quota checks per item can amplify database
  load. Use set-based aggregates for page item ids and validate the plan with
  realistic data before adding indexes.
- **GET/POST identity mismatch:** current POST trusts body `user_id`. Use trusted
  metadata in both paths and cover mismatch attempts with tests.
- **Midnight drift:** separate `time.Now()` calls can disagree at the reset
  boundary. Capture one evaluation time and reuse the existing Bangkok helper.
- **GET/POST race:** advisory eligibility can become stale. Keep POST locked and
  authoritative, with stable machine-readable failures.
- **Contract rollout drift:** an old gateway can omit unknown nested fields.
  Publish shared-lib first, then bump each consumer sequentially.
- **Ambiguous retention language:** current hard deletes cascade favorites.
  Keep that behavior explicitly out of scope rather than inventing tombstones.

## Out of scope

- Point-balance eligibility or Wallet calls from list endpoints.
- Mobile UI implementation, dimming, countdown rendering, or localization.
- Backoffice quota configuration changes.
- New favorite tombstone/history storage for hard-deleted items.
- Refactoring the pre-existing general redemption list/query architecture.
- New reason codes beyond the three confirmed by Mobile/Product.
- Commit, push, PR, merge, deployment, or production mutation during planning.

## Assignment

- Primary: `dev-2`
- Parallel: `false`
- Reason: shared protobuf/generated artifacts, published dependency gates,
  authenticated identity behavior, SQL filtering, and gateway adoption must be
  delivered and reviewed sequentially.

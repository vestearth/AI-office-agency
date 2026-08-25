# TASK-EAR-283 — Connect Monitoring Player Detail to Existing APIs

## Type / workstream / priority

Feature / frontend / high

## Description

Replace fabricated data only on `admin/monitoring/report/player/:id` in
`Games-Labs-backoffice`, using the canonical UUID from the route parameter for
every API request. Do not use the display Player ID or the optional `name`
query parameter as an API identity.

Current source establishes that `ListPlayerGameActivity` can back the Game tab,
and the existing point/wallet history, orders-for-user, and store-purchases
endpoints can back most History Transaction sub-tabs. They do **not** establish
data sources for Provider turnover, Complimentary Item/Discount Code redemption
history, or all Summary cards. This task must not substitute derived or zero
values for those missing semantics. Product/owner confirmation is required
before implementation claims that every monitoring mock is removed.

## Source-verified scope

- `Games-Labs-backoffice/app/pages/admin/monitoring/report/player/[id].vue` —
  currently owns an entirely fabricated `summary` and does not pass the UUID to
  child tabs.
- `Games-Labs-backoffice/app/components/PlayerReportGameTab.vue` — replace
  `TOP_PERFORMANCE_ROWS` and `getPlayerGameRows` usage with the existing game
  activity composable.
- `Games-Labs-backoffice/app/components/PlayerReportHistoryTab.vue` — replace
  `getPlayerHistoryTable(...).rows` with the existing order, point, wallet, and
  store-purchase composables while retaining its presentation-column contract.
- `Games-Labs-backoffice/app/components/PlayerReportProviderTab.vue`,
  `PlayerReportPromotionTab.vue`, and `PlayerReportSummaryPanel.vue` — contain
  fabricated rows/values, but have no verified existing API that supplies their
  required data.
- Existing reusable API owners are `useAdminPlayerGameActivity.ts`,
  `useAdminPlayerPurchaseHistory.ts`, `useAdminPlayerPointHistory.ts`,
  `useAdminPlayerSendCoinHistory.ts`, and `useAdminPlayerStorePurchases.ts`.
  Their current non-200 envelope behavior collapses failure into an empty result
  and several fetch-all helpers preclude server pagination; adapt their result
  contract only after the decision gate specifies which views are in scope.

## Product decision

The product owner approved option 1 below. Provider, Promotion, and Summary
must render an explicit unavailable state in this task; they will receive real
data through TASK-EAR-291 after the monitoring projection is available.

The implementation must use true page/total metadata supplied by the selected
API. It must not page by fetching an arbitrary capped set and slicing it
client-side.

## Additional dependency discovered during implementation

The existing `ListPlayerGameActivity` response has no total and its request
has no offset. TASK-EAR-293 adds this additive pagination contract. This task
must remain blocked until it is published and adopted; using the endpoint's
current 100-row cap would make the page's total and paging controls dishonest.

Historical decision record:

1. Narrow this task to the Game tab and History Transaction sub-tabs covered by
   the four existing API families; retain unavailable Provider, Promotion, and
   Summary sections with an explicit unavailable state, **or**
2. Supply/approve the existing endpoint and field contract for per-player
   provider turnover, promotion usage/grants, and the Summary aggregates; a
   new backend projection is outside this task's stated scope and must be a
   separately authorized dependency.

## Acceptance criteria after the decision gate

1. Each approved, API-backed Player Detail section requests data with the
   canonical UUID from `route.params.id`; the display ID/name is never sent as
   the user identity.
2. Approved Game and History data render from the existing API families and no
   fabricated row/summary data is rendered for an API-backed state.
3. A non-success response envelope (for example `status.code !== 200` or
   `status !== 'success'`) produces a visible error state distinct from a
   successful empty response; HTTP failures do the same.
4. Each approved table deliberately renders loading, empty, error, nullable,
   and server-paginated states. Pagination sends the selected limit/offset and
   honors the API total.
5. Provider, Promotion, and Summary sections not covered by an approved API
   contract render an explicit unavailable state or are removed from this
   route; they do not display mock data, fabricated zeroes, or guessed
   aggregates.
6. No route outside `admin/monitoring/report/player/:id` changes behavior.
7. Focused tests cover UUID propagation, success/empty/envelope-error/HTTP
   error mapping, and pagination requests; `npm test` and `npm run build` pass
   in `Games-Labs-backoffice`.

## Ordered technical plan

1. Resolve the decision gate and record the approved sections and their exact
   endpoint/field contracts. If an API is missing, split backend contract work
   into a separately authorized task instead of deriving a result locally.
2. Extend the existing composables' result types to return rows, total, and a
   distinguishable envelope/API error. Reuse their row mappers; do not create
   parallel API clients. Preserve actual server pagination at the page boundary.
3. Thread the canonical route UUID and state/result objects through the report
   page into the approved tab components. Replace Game/History mock datasets
   only after their API state is available.
4. Apply the approved disposition to Provider, Promotion, and Summary. Remove
   their mock constants only where an API contract is confirmed; otherwise show
   a deliberate unavailable state.
5. Add focused tests and run the production build. Verify no references to the
   route's old mock datasets remain in the approved API-backed paths.

## Risks

- The task's "no monitoring mock datasets" requirement conflicts with the
  verified endpoint coverage. Mitigation: block at the product/API decision
  gate; do not manufacture provider, promotion, or aggregate semantics.
- Existing composables turn envelope errors into empty arrays and fetch multiple
  pages internally. Mitigation: expose a typed outcome and server total before
  binding pagination UI.
- Route links use `row.playerId`; its runtime value must remain the canonical
  UUID. Mitigation: add a focused route-propagation test and encode only that
  value.
- Nullable values such as absent win statistics are semantically distinct from
  zero. Mitigation: retain established dash rendering and test it.

## Out of scope

- New backend APIs, `shared-lib` changes, reporting aggregates, Android edits,
  deployment, or production-data verification.

# TASK-EAR-347: Fill the Detail page History Transaction and Game tables from fields the API already returns

## Type
feature

## Workstream
frontend

## Priority
medium

## Created
2026-09-11

## Parent
[[detail-page-backend-epic]]. TASK-EAR-326/327/328 (Backoffice PR 114/115/116/117,
all merged 2026-09-07) finished the truthfulness pass: the page no longer asserts
mock values and a failed load no longer renders as an empty history. The next gap
is the opposite shape — every endpoint these two tabs call returns **more fields
than the tables display**, and several are already declared in the composables'
own TypeScript types but never mapped into a row.

## Goal
Both tabs show the data the wire already carries. No proto change, no gateway
bump, no backend deploy — every item below was verified present in the response
the browser receives today.

## Scope

In — `Games-Labs-backoffice` only:

**A. Purchase → Package** (`useAdminPlayerPurchaseHistory.ts`)
- Add an **Order status** column from `status` (`orderpb.Order.status`, emitted by
  `adminOrderToPB` at `adminorderhdl.go:639`). This is the highest-value item and
  is a correctness fix, not decoration: `ListPaginated`
  (`Games-Labs-Order/internal/core/repositories/order.go:155-158`) filters on
  `user_id` only, so PENDING / FAILED / REFUNDED orders are listed today looking
  exactly like paid ones. Enum has 8 values incl. `ORDER_STATUS_PENDING`,
  `_FAILED`, `_REFUNDED`, and both `_FULFILLED` and `_SUCCESS`; map them to
  display labels explicitly, never render the raw enum string.
- Add **Order No.** from `orderNo`.
- Remove the hard 50-row cap (`query: { 'page.size': '50' }`) and page properly.
  `ListOrdersForUserResponse.page` is a `basepb.Pagination` carrying `total`, and
  the handler populates it from a real `CountOrders` — so the paging loop needs no
  backend work. Follow the existing `fetchAllPointHistory` loop shape.

**B. Purchase → Special Pass / Limited Avatar** (`useAdminPlayerStorePurchases.ts`)
- Add **Type** and **Duration** from `pass_type`, `is_permanent`,
  `duration_seconds`. All three are already in `AdminStorePurchaseApiItem` and
  already selected by `store_repo.go` — declared, fetched, and then dropped by
  `toStorePurchaseRow`.
- Keys stay snake_case here: this endpoint is `structpb.Struct` passthrough, NOT
  a typed proto (TASK-EAR-076 trap, already documented in the file).

**C. Earned → Point / Redeem → Point** (`useAdminPlayerPointHistory.ts`)
- Add **Balance after** from `pointsAfter` (`pointsBefore` is there too).

**D. Send coin → Sent / Received** (`useAdminPlayerSendCoinHistory.ts`)
- Add **Balance after** from `coinAfter`.
- Resolve the counterparty **User Name** instead of rendering the raw
  `counterpartyUserId`. `resolveActorIdentity`
  (`useAdminPlayerAuditEvents.ts:471`) already does exactly this lookup and is
  deliberately best-effort/null-falling-back — reuse it, do not make it throw.
  Account number has no backing field anywhere and stays `-`.

**E. Game tab** (`useAdminPlayerGameActivity.ts`)
  One endpoint feeds all three sub-tabs and returns every field below on every
  call; each sub-tab currently renders a subset.
- Top Performance: add **Round played** (`roundsPlayed`) and **Last played**
  (`lastPlayedAt`).
- Frequently played: add **Last played** (`lastPlayedAt`).
- Last played: add **Round played**, **Max Coin Win**, **Total Wins** — the last
  two via the existing `normalizeWinStats`, which already encodes the
  "`capturedRounds == 0` renders `-`, never `0`" rule.
- All three: add **Provider**. `useAdminGamesCatalog` already maps
  `provider: g.providerName`, and `withCatalogThumbnails` already joins that
  catalog by `gameId` — it just discards everything except the image.

Out:
- Any proto / shared-lib / api-gateway / backend service change. Anything needing
  one belongs to the follow-up run, not here.
- The read-only Android reference repo.
- Filter / Export buttons and the unused date range (still demo `alert`s).
- Server-side pagination for Point / Store / Send Coin (they cap at 5,000 rows);
  only the Package 50-row cap is in scope, because that one is 50.

## Verified NOT available — do not re-scope these into this run

- **Earned → Point "Detail" must stay `-`.** The mission reward path writes point
  rows through `CreditPoints`, whose service and repo signatures carry no metadata
  argument at all; `wallet.go:1127` calls `insertWalletPointsTx(..., nil)`. So
  `metadataJson` is empty `{}` on exactly the rows this column would describe.
  Only the `point_turnover` path (`wallet.go:247`) passes real metadata. An
  earlier read of this task claimed `reference_type`/`reference_id` were available
  here — that was wrong, and it is written down here so it is not rediscovered as
  a "gap".
- Payment method (no field on the Order schema, only a gateway tx reference),
  Send-coin account number, Redeem "Send via" and the redeemed item's name (no
  admin per-user redemption-record RPC exists — only the public surface).

## Acceptance criteria
- Every column added above renders a real value, or a dash when the field is
  genuinely absent. No fabricated `0`, no placeholder text.
- A PENDING or FAILED order is visually distinguishable from a paid one in
  Purchase → Package.
- Purchase → Package pages past 50 rows, driven by `page.total`.
- Send-coin counterparty name resolution failing does not empty or error the
  table — it falls back to the raw id, matching `resolveActorIdentity`'s
  existing contract.
- Focused tests seen RED before the change and GREEN after.

## Traps (from the epic's own history — read before writing tests)
- Columns for these tables are a design contract in
  `Games-Labs-backoffice/app/data/mock.ts` (`getPlayerHistoryTable`); rows come
  from the API and never from that file. Adding a column means editing the
  contract there, and some existing tests assert column counts.
- **On this page a green suite is not evidence the behaviour is right.** Between
  TASK-EAR-326 and 327, six existing assertions had to be rewritten because they
  encoded the defect they were testing. Grep for assertions protecting current
  behaviour before changing a mapper.
- Every int64 on these endpoints (`pointsAfter`, `coinAfter`, `totalWins`,
  `capturedRounds`, `page.total`) arrives as a JSON **string**. `maxCoinWin` is
  the exception: a JSON number, and its key is **absent** rather than `0` when no
  win was ever captured.
- The design owns this page's layout. Wire data into the existing components;
  do not replace designed components while adding columns
  ([[preserve-ux-design-wire-data-only]]).

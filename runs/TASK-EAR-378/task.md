# TASK-EAR-378 — Monitoring report drill-down pages

## Why

Every monitoring report list route is API-backed and verified live. The
drill-down routes under `/admin/monitoring/report/<type>/<id>` are the last
mock-backed surface: each one carries a hardcoded catalog keyed by id and a
hardcoded list of player rows. They are what keeps acceptance criterion 2 of
TASK-EAR-291 unmet.

## What exists already

`ListReportDrilldown` is **already on the contract** — no proto change:

```
rpc ListReportDrilldown(ListReportDrilldownRequest) returns (ListReportDrilldownResponse)
option (google.api.http) = {get: "/api/v1/admin/reports/{report_type}/{entity_id}/drilldown"}
```

`ReportDrilldownItem` carries event_id, occurred_at, user_id, player_id,
user_name, vip_level, currency, source_reference_id, status, note and a
per-type `oneof detail` (gameplay, store_purchase, mission,
special_item_purchase, promotion_usage, redemption_usage).

In Games-Labs-Logs the handler is a **stub**: it validates the report type and
entity id, then returns an empty item list with the partial-data reason. The
per-type WHERE builders it needs already exist, written for the list
aggregations (`buildMonitoringPackageReportWhere`,
`buildMonitoringSpecialItemReportWhere`, `buildMonitoringPromotionReportWhere`,
`buildMonitoringRedemptionReportWhere`, `buildMonitoringMissionReportWhere`).

Entity key per type, all already columns on `monitoring_player_events`:

| report | filter |
|---|---|
| package | `package_id`, `source_reference_type = 'order'` |
| special-item | `package_id`, reference type `avatar` / `pass` |
| promotion | the payload coupon code |
| redemption | `redemption_item_id` |
| mission | `mission_id` |
| game | `game_id` — **see the caveat below** |

## Verified constraint — VIP level

Every detail table's first three columns are Username / Player ID / VIP Level.
A live read of `/admin/monitoring/player-logs/store` (2026-09-21) returns
`userName` and `playerId` resolved, so those two fill. **VIP level is on no
event and in no projection**, so it stays `-` until a profile dimension is
published. Do not infer it from the player's current level: the table states
what was true at the time of the purchase, and today's level is a different
fact.

## Caveat — the game detail page is not the same shape

Game's detail table is an aggregate **per player** (Turnover, Win Amount,
Player W/L, THB W/L per row), not a list of events. `ReportDrilldownItem` is
one row per event, so game needs either a grouped query behind the same RPC or
its own decision. Scope it separately; do not force it into the first pass.

## Order

1. **package** — its player-log row already carries every column the table
   renders except VIP level (purchase id, currency, payment gateway, assets,
   promotion code, discount, original price), so it is the cleanest proof that
   the drill-down contract works end to end.
2. redemption, special-item, promotion, mission — same shape, one at a time.
3. game — after a decision on the aggregate shape.

## Acceptance

- No `report/*/[id].vue` renders a figure that no source produced. Where the
  contract has nothing, the page says so, the way the Monthly and Event
  mission tabs do.
- Each drill-down list is server-paged and totals come from the response, never
  from a client-side sum over one page.
- Each report type is read on admin-dev after its deploy, not trusted from a
  green suite - four defects on the mission report passed tests and build.

## 2026-09-30 mission detail decision and contract gate

The operator chose to keep the designed daily/weekly detail page grouped by
**plan**, with one paged row per player and that plan's missions nested in the
row. The current route passes a plan ID. The Logs drill-down accepts one
`mission_id` and returns one event per row; it cannot truthfully page this
table or calculate plan completion by paging its events. Monthly and Event
remain explicitly unavailable until their owning admin data sources exist.

The next contract belongs to Missions, which owns the plan and the per-player
daily/weekly progress and claim records. Proposed additive, staff-only admin
read in `shared-lib/proto/admin/adminmissionpb/adminmission.proto`:

- `GET /api/v1/admin/{period}/plans/{plan_id}/players`, where `period` is
  validated to `daily` or `weekly`. Request fields: `plan_id`, `period`,
  `search`, `limit`, `offset`, and allowlisted sort direction/key.
- Response: `items` of one player per row, `total` of matching players
  before paging, the canonical plan ID and period, and explicit coverage or
  partial-data state. Each row identifies the player and includes each plan
  activity's ID, progress/completion, reward claim status and claim time.
  Group bonus claim state is separate. The frontend joins activity names and
  reward terms from the plan; it does not assume a reward was claimed merely
  because it was configured.
- Unknown plan ID returns NotFound; invalid period, sort, or page inputs
  return InvalidArgument. An empty plan or no participating players returns
  `items: []`, `total: 0`. Search and sorting happen before server paging.

This is a **proposal**, not a shipped contract. Before implementation, verify
the daily and weekly repository claim/progress tables can support every row
field without inventing historical bonus claims. Keep any unsupported field
unknown in the response and render a dash in Backoffice. The new protobuf
contract and generated artifacts must be published and bumped in Missions and
api-gateway before downstream code is changed, per workspace policy. This
linked slice expands the implementation scope to shared-lib, Missions,
api-gateway and Backoffice only after that publication gate; Logs' existing
per-mission event drill-down remains unchanged.

The additive shared-lib source and generated artifacts were committed as
`b7a4cdf` and merged as [shared-lib PR #84](https://github.com/SparqLab/shared-lib/pull/84)
into the verified target `main` on 2026-09-30, merge commit `4066910`.
It adds `ListMissionPlanPlayers` to `AdminMissionsService` using the route
above, typed request/response messages, and a presence-based claim message.
The response carries `items`, `total`, `partial_data`, and
`partial_data_reason`. Daily activity claim rows record time but no award
amount, so `MissionPlanClaim.reward_amount` is optional. Generation,
`GOWORK=off GOFLAGS=-mod=readonly go test ./...`, and Buf FILE breaking check
against `main` passed; the repository-wide Buf lint remains red on
package/RPC naming rules.

The published version `v0.0.0-20260930091000-4066910ded9d` is now bumped in
Missions [PR #133](https://github.com/SparqLab/Games-Labs-Missions/pull/133)
and api-gateway [PR #80](https://github.com/SparqLab/api-gateway/pull/80),
both verified targeting `staging`. Backoffice
[PR #161](https://github.com/SparqLab/Games-Labs-backoffice/pull/161) is
verified targeting `main` under its repo deployment policy. The Missions
service implements a plan-level, server-paged player read. The Backoffice
detail page uses that read and displays claim values only when a ledger
snapshot exists. Daily reward amounts and plan bonus attribution remain
unknown and are reported as partial data.

Local read-only builds/tests passed in Missions and gateway; Backoffice build
and all 709 tests passed. The existing plan-list window limits detail
discovery for older plans.

## 2026-09-30 staging read and plan-total correction

Missions PR #133, api-gateway PR #80, and Backoffice PR #161 were merged.
The staging workflows for both ECS services completed; current ECS task
definitions are Missions `:148` and gateway `:122`, with matching images,
completed rollouts, and 1/1 running tasks. Backoffice's main branch pins the
image for merge `c02c54b`. The live Backoffice runtime uses
`api-test-gateway.gameslabs.app`; its health returned 200 and the new admin
route returned the expected 401 without a session.

An authenticated admin-dev read of daily plan Sep 23 showed 3 distinct
players with the plan's activities nested in each row. Weekly plan Sep 7-13
showed 6 distinct players, a recorded weekly claim amount on one activity,
unknown claims as dashes, and the API's partial-data notice. Search for a
nonmatching User ID returned 0 results, and clearing it restored all 6. The
largest available plan had fewer than 10 players, so a second detail page
could not be exercised live.

The weekly list for Sep 7-13 displayed `0/3` Completed/Participants while
its detail displayed 6 players. Source inspection confirmed that the list
used the maximum per-mission assigned count and minimum per-mission completed
count as though they were distinct plan-level counts. Those sets can differ.
Backoffice [PR #162](https://github.com/SparqLab/Games-Labs-backoffice/pull/162)
removes that inference and displays unknown plan totals as `-` while retaining
the per-mission Players figures. It targets `main`; 709 tests and the build
passed. PR #162 merged as `74c90bc`; Build and Deploy run `36702035655`
succeeded and main pinned image `sha-74c90bc`. An authenticated admin-dev
reload confirmed the Sep 7-13 weekly row now displays `-/-` as unknown
plan totals while mission Players values remain.

## Next source finding — Game detail

The Game detail route still renders a static catalog and eight invented
player rows. Its design is one row **per player**, with turnover, win amount,
and W/L aggregates. Logs' existing `ListReportDrilldown` returns one event
per row, and its handler explicitly excludes Game. The Game report list
already aggregates settled, unreversed rounds from
`monitoring_round_outcomes FINAL` by game/type/currency. A truthful player
detail should use that same round state grouped by user and currency, with
server paging and a matching total. `monitoring_game_player_daily` is an
older summing projection; it should not be assumed equivalent to the current
list's latest-round semantics without verification.

The current contract has no typed per-player Game report read.
`GetReport` contains summary/metrics but no paged players, and
`ReportDrilldownItem` is event-shaped. A new shared-lib contract, Logs
implementation, gateway bump, and Backoffice wiring need an explicit
cross-repo scope decision. Historical VIP level, registration time, and THB
W/L are not published by the current Game report projection and must remain
unknown unless their owning source can supply them. This is source analysis,
not an implementation or runtime acceptance claim.

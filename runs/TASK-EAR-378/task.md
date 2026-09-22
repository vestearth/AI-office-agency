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

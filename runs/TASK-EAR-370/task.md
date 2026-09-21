# TASK-EAR-370 — Publish Monitoring report measures and the catalog filters the report pages need

## Origin

Raised out of TASK-EAR-291 (Connect Monitoring Report pages). The Backoffice
list routes for player, game, provider and package are API-backed and live
(PR #135, #136). The remaining four report routes could not be wired: the
server publishes no rows for them.

Extends TASK-EAR-284 (Define and publish Admin Monitoring contracts, done),
which established `/api/v1/admin/reports/*`.

## Type

feature

## Workstream

backend

## Decision record — settled with the operator 2026-09-21

The original framing of this run ("how do catalog and profile dimensions reach
Logs — published dimension events or read-time S2S lookups?") was **wrong**,
and the run has been re-scoped. Grilling it against source showed that every
catalog the report pages need already has a live admin list API that the
Backoffice already calls. Nothing needs to be moved into Logs.

**D1. Logs serves measures only.** `/api/v1/admin/reports/{report_type}`
returns behavioural aggregates keyed by entity id — counts, unique players,
rates, turnover. It does **not** return names, artwork, prices, quotas,
statuses or sale windows.

**D2. The owning service drives the page.** Each report page reads its rows
from the catalog owner's existing admin API, which already applies search,
date range, type/status filters and paging, then joins the measures by id on
the client.

**D3. Logs gains no outbound dependency.** No gRPC or HTTP client from Logs to
Order, Missions or User. No dimension events, no dimension tables in
ClickHouse, no backfill.

**D4. `monitoringpb` does not grow to mirror catalog fields.** The existing
report summary messages are measures messages. `MissionReportSummary` is
already exactly that shape (assigned / completed / claimed players, completion
and claim rate) and needs no change at all — the earlier reading of it as a
"flat row that cannot express the grouped page" was a misreading.

**D5. `game` is unchanged and stays whole.** It has no catalog side; it is
aggregated purely from `monitoring_round_outcomes` inside Logs, so it keeps
full server-side sorting on measures and needs nothing from this run beyond
the dimensions listed under "Frontend flag" below.

**D6. Mission history extends to 6 months.** The plans board is currently
capped at a hardcoded window (see below); the operator chose 6 months of
history rather than unlimited.

### What this decision costs

Sorting or filtering **by a measure** (for example "sort by purchase count",
"show items with more than 100 redemptions") is not possible for the seven
catalog-driven types, because the catalog decides the page before measures are
attached. This was accepted: no report type offers measure sorting today —
`validateReportSort` allows `created_at` only for everything except `game`,
and `game` is unaffected because it has no catalog side.

Each catalog-driven page makes two calls and joins client-side.

## Scope

- `shared-lib` — **request messages only**, to add the filters three catalog
  endpoints are missing. No new services, no new report messages.
- `Games-Labs-Order` — honour the new package filters.
- `Games-Labs-Provider` — honour the new provider paging.
- `Games-Labs-Missions` — filters and the 6-month window on the plans board,
  plus its gRPC bridge wrapper.
- `Games-Labs-Logs` — build the measures aggregations for the seven types that
  currently return an empty list. **The `package` slice is split out as
  TASK-EAR-371**, which also covers the three package header figures; it needs
  no contract change and can run independently of everything here.
- `api-gateway` — regenerated artifacts only.
- Out of scope: `Games-Labs-backoffice` page wiring (TASK-EAR-291 owns it and
  picks these up once the contracts land).

## Per-report state (verified 2026-09-21 against source)

| Report | Catalog endpoint that drives it | search | date | paging | other | needs |
|---|---|:-:|:-:|:-:|---|---|
| player | `/admin/user` (`ListUserRequest`) | yes | yes | yes | — | measures only |
| game | none — Logs-native | yes | yes | yes | full measure sort | nothing |
| redemption | `/admin/redemption-items` | yes | yes | yes | — | measures only |
| special-item | `/admin/special-items` | yes | yes | yes | `item_type`, `active` | measures only |
| promotion | `/admin/promotion-coupons` + `/admin/discount-coupons` | yes | yes | yes | — | measures only |
| **package** | `/admin/order-packages` (`ListPackagesRequest`) | **no** | **no** | **no** | only `type`, `active`, `include_all` | **add search, date range, limit/offset** |
| **provider** | `/admin/provider` (`ListProviderRequest`) | yes | yes | **no** | — | **add limit/offset** |
| **mission** | `/admin/daily\|weekly/plans` | **no** | **no** | **no** | no parameters at all | **add filters + widen window** |

`/admin/user` already composes across services itself — lifetime top-up from
Wallet in batch (TASK-EAR-318) and GGR from Game over S2S (TASK-EAR-320),
because the `user_profiles.lifetime_*` columns were dropped (TASK-EAR-321).
That is the same composition pattern this run standardises on; do not
reintroduce those columns.

## Mission plans: two problems behind one endpoint

`GetWeeklyPlansBoard` and `GetDailyPlansBoard` take **no parameters**. The
window is hardcoded in the service:

- `internal/services/weekly_admin.go:297-298` — `-7*4` to `+7*5`, i.e. four
  weeks back to four weeks forward.
- `internal/services/daily_admin.go:98-99` — `-7` to `+8`, i.e. seven days back
  to seven days forward.

So the Mission report cannot show anything older than four weeks (daily: one
week), and the search box and date-range picker on that page have nothing to
bind to. This limit is independent of how the report is composed — it would
have been hit either way.

**D6 applies here:** widen history to **6 months** back. Keep a forward window
for scheduled plans. Make the range a request parameter with the 6-month span
as the default and the maximum, rather than removing the bound.

**Bridge trap:** these routes reach the gateway through the adminmission gRPC
bridge, and its wrappers are `func(ctx, *emptypb.Empty)` calling
`s.call(ctx, handler, GET, "/api/v1/admin/weekly/plans", nil)` — the path and
query are a hardcoded literal with no query string. Adding query parameters to
the mux handler alone will **not** make them reachable through the gateway. The
wrapper's request type must change from `Empty` to a request message and build
`pathAndQuery` from it. `httpx.CallHandler` already takes a path *and query*,
so nothing in the bridge itself needs to change.

## Acceptance criteria

1. `ListReports` returns real measures for every type in `allowedReportTypes`,
   keyed by the same canonical entity id the catalog endpoint returns, or the
   run records which types stay unpublished and why.
2. `GetReport` and `ListReportDrilldown` return real data for the types whose
   measures land, using those same canonical ids. TASK-EAR-291 acceptance
   criterion 2 is blocked on this — every `report/*/[id].vue` drill-down route
   is still mock and nothing calls either RPC.
3. `/admin/order-packages` accepts search, date range and limit/offset;
   `/admin/provider` accepts limit/offset; the plans board accepts search, an
   explicit date range and paging, defaulting to and capped at 6 months of
   history.
4. `partial_data` / `partial_data_reason` keep one fixed meaning: **true means
   the rows are real but some columns are unavailable**. An empty list must
   never signal a failure — a catalog or measures failure is an error response,
   because `items: []` with `partial_data: true` cannot be told apart from
   "there is genuinely nothing here", which is the defect the seven stub types
   have today.
5. Any column a page offers for sorting has a matching allowlist entry on
   whichever side owns that sort, and the pairing is covered by a test.
6. Contract changes are additive and wire-compatible; generated protobuf,
   gateway and Swagger artifacts are regenerated, never hand-edited.

## Frontend flag to flip when dimensions start publishing

`Games-Labs-backoffice` `app/pages/admin/monitoring/report/game/index.vue`
holds `PUBLISHED_DIMENSIONS = { pointGenerated: false, thbWl: false }`. The
gateway runs with **EmitUnpopulated**, so a numeric field the service never
sets arrives as a literal `0`, indistinguishable from a real zero — a
"show a dash when missing" branch is dead code for any non-`optional` numeric
proto field. Logs omits `point_generated` from the ListReports mapper and
hardcodes `toFloat64(0) AS player_win_loss_thb`, so both columns read as
unknown behind that flag. Flip each to `true` in the same change that starts
publishing it, or the new values stay hidden. `game_name`, `provider_id`,
`provider_code` and `currency` are empty strings today and already fall back
to "-" correctly; only numbers need the flag. Confirmed live 2026-09-21
against 46 games via `api-test-gateway`.

## Deploy order

1. `shared-lib` — request-message additions for packages, provider and the
   mission plans board; tag it.
2. `api-gateway` — bump the pin and regenerate. The gateway owns the wire
   format, so its bump ships with the proto change, not after it.
3. `Games-Labs-Order`, `Games-Labs-Provider`, `Games-Labs-Missions` — bump the
   pin and honour the new filters.
4. `Games-Labs-Logs` — measures aggregations. Independent of 1-3 and can run in
   parallel; it touches no contract.
5. `Games-Labs-backoffice` — page wiring under TASK-EAR-291.

## Traps

- **Do not cache a query result.** A catalog attribute cached per id is fine
  (`monitoring_actor_resolver.go` caches identity for 5 minutes); caching a
  *filtered page* means an admin edits an item and a refresh still shows the
  old one.
- **Logs prod carries 9fba334 (task definition :12).** Confirm what prod runs
  before assuming a contract is live there; see the TASK-EAR-343 record.
- **Prod ECS is scaled to 0 outside 09:00-18:00 Mon-Fri.** A 503 at night is
  the schedule, not an outage, and deploys belong inside the window.
- **ClickHouse projections are replayed, not migrated in place.** Any new table
  or materialised view needs an idempotent create path, matching how
  `monitoring_round_outcomes` is built.
- **Do not hash or narrow a live dedupe key.** The monitoring admission key was
  widened to VARCHAR(512) in TASK-EAR-343 for 159-character nested Mission ids.
- **int64 fields reach the client as JSON strings.** `total` already arrives as
  `"46"`; every count added here needs the same parse-as-string note.

## Verification

- Unit tests per measures aggregation with a seeded ClickHouse fixture,
  including a row whose dimensions are missing, which must still be returned
  with `partial_data` rather than dropped.
- A filter test per changed catalog endpoint: search, date range and paging
  each narrow the result, and the plans board rejects a range beyond 6 months.
- An explicit failure test: a catalog or measures failure returns an error, not
  an empty list.
- Staging: call each `/api/v1/admin/reports/{report_type}` through
  `api-test-gateway` with a staff token and record row counts and
  `coverage_start` per type as evidence.
- Backoffice re-check under TASK-EAR-291: the four blocked routes render rows
  once their measures land, and the mission page shows history older than four
  weeks.
- Do not accept a zero-row result as proof. A count of zero cannot tell a
  working projection from an empty one; pair it with a known-present entity.

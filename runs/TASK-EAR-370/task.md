# TASK-EAR-370 — Publish the remaining Monitoring report projections and their contract fields

## Origin

Raised out of TASK-EAR-291 (Connect Monitoring Report pages). The Backoffice
list routes for player, game, provider and package are now API-backed on
`task/TASK-EAR-291-monitoring-reports`. The remaining four report routes could
not be wired: the server publishes no rows for them, and for four report types
the proto does not carry the columns the approved pages render.

Extends TASK-EAR-284 (Define and publish Admin Monitoring contracts, done),
which established `/api/v1/admin/reports/*`.

## Type

feature

## Workstream

backend

## Goal

Make `ListReports` return real rows for every allowed report type, and extend
the report summary messages so the published contract covers the columns the
Monitoring report pages actually render.

## Scope

- `shared-lib` — `proto/admin/monitoringpb/monitoring.proto` report summary
  messages and regenerated artifacts.
- `Games-Labs-Logs` — ClickHouse projections and the `monitoringhdl`
  ListReports / GetReport / ListReportDrilldown handlers, plus the
  `validateReportSort` allowlist.
- `api-gateway` — regenerated gateway artifacts only; the endpoints are already
  registered (`gateway/grpc.go`, `MonitoringReports` → `LogsAPIURL`).
- Out of scope: `Games-Labs-backoffice` (TASK-EAR-291 owns the frontend and
  picks these up once the contract lands).

## Current state (verified 2026-09-21 against source)

`Games-Labs-Logs/internal/core/handlers/monitoringhdl/grpc.go`

- `allowedReportTypes` accepts all eight types.
- `ListReports` has a real branch only for `report_type == "game"`, reading
  `ClickHousePlayerActivityProjector.ListMonitoringGameReports`
  (`infrastructures/monitoring_clickhouse.go:505`), which aggregates
  `monitoring_round_outcomes FINAL` excluding reversed rounds.
- Every other type falls through to a literal empty response with
  `partial_data: true` and the reason "Report aggregate projection is not
  authoritative until provider, catalog, and profile dimensions are published."
- `GetReport` sets no summary at all, for every type including `game`.
- `ListReportDrilldown` returns an empty item list for every type.
- `validateReportSort` allows `created_at` only unless the type is `game`;
  anything else is `InvalidArgument`. The game allowlist is `created_at`,
  `game_id`, `total_players`, `total_rounds`, `turnover`, `win_amount`, `rtp`,
  `wl` — note `game_type`, `point_generated` and `thb_wl` are NOT sortable.
- Even the game rows leave `game_name`, `provider_id`, `provider_code` and
  `point_generated` unset, and `player_win_loss_thb` is a literal
  `toFloat64(0)` in the ClickHouse query. Confirmed live on 2026-09-21 against
  46 games via `api-test-gateway`: the empty strings arrive as `""` and the
  absent numbers arrive as `0`, because the gateway emits unpopulated fields -
  so an unavailable numeric dimension cannot be told apart from a real zero on
  the wire. See the frontend flag section below.

Source events are not the blocker: `monitoring_player_events` already ingests
the `account`, `vip-level`, `gameplay`, `wallet`, `store`, `mission`,
`free-coin` and `redemption` log types. What is missing is the dimension data
(names, types, artwork, quotas, prices, profile attributes) owned by Missions,
Order, User and the redemption catalog.

## Contract gaps (shared-lib `monitoringpb`)

| Report type | Fields the page renders that the message does not carry |
|---|---|
| mission | The page is a grouped daily/weekly/monthly/event structure with nested tasks; `MissionReportSummary` is a single flat row. Needs a container shape decision, not just extra fields. |
| special-item | artwork, collection, secret type, duration, VIP level, detail text, game-support count |
| promotion | reward list, pass list, avatar list |
| redemption | unit price (`spent_point` is a total, not a price), artwork |

`PlayerReportSummary`, `ProviderReportSummary` and `PackageReportSummary` map
cleanly already — they need the projection, not new fields.

## Open decision (blocks implementation — resolve first)

How do catalog and profile dimensions reach Logs?

- **A. Published dimension events** — owning services publish create/update
  events for missions, packages, special items, promotions and redemption
  items; Logs keeps dimension tables in ClickHouse and joins locally. Keeps
  reads fast and self-contained; adds new event contracts and a backfill for
  existing catalog rows.
- **B. Read-time S2S lookups** — Logs aggregates IDs from ClickHouse and
  resolves names/attributes per request against the owning services. No new
  event contracts and no backfill; adds fan-out latency and a runtime
  dependency on four services in a staff read path.

Record the choice and the reasoning before any proto edit — it decides whether
this run also adds event contracts.

## Acceptance criteria

1. `ListReports` returns real rows for every type in `allowedReportTypes`, or
   the run explicitly records which types stay unpublished and why.
2. Report summary messages carry every column the approved Monitoring report
   pages render; anything deliberately left out is named in the run.
3. `GetReport` and `ListReportDrilldown` return real detail and drill-down data
   for the types whose projections land, using canonical entity IDs.
4. Any column a page offers for sorting has a matching `validateReportSort`
   allowlist entry, and the pairing is covered by a test.
5. `partial_data` / `partial_data_reason` stay honest: true only while a
   dimension really is unavailable, with a reason that names it.
6. Contract changes are additive and wire-compatible; generated protobuf,
   gateway and Swagger artifacts are regenerated, never hand-edited.

## Frontend flag to flip when dimensions start publishing

`Games-Labs-backoffice` `app/pages/admin/monitoring/report/game/index.vue`
holds `PUBLISHED_DIMENSIONS = { pointGenerated: false, thbWl: false }`. Because
the gateway emits unpopulated fields, an unpublished dimension reaches the
client as a literal `0` that cannot be told apart from a real zero, so the page
renders those two columns as unknown. Flip each flag to `true` in the same
change that starts publishing that dimension, or the new values stay hidden.
The same applies to `game_name`, `provider_id`, `provider_code` and `currency`,
which the ListReports mapper leaves empty today and the page renders as "-".

## Deploy order

`shared-lib` (tag) → `api-gateway` (bump pin, regenerate) → `Games-Labs-Logs`
(bump pin, projections). The gateway owns the wire format, so its shared-lib
bump ships with the proto change, not after it.

## Traps

- **Logs prod carries 9fba334 (task definition :12).** Confirm what prod is
  actually running before assuming a contract is live there; see the
  TASK-EAR-343 record.
- **Prod ECS is scaled to 0 outside 09:00–18:00 Mon–Fri.** A 503 at night is
  the schedule, not an outage, and deploys belong inside the window.
- **ClickHouse projections are replayed, not migrated in place.** Any new
  table or materialised view needs an idempotent create path, matching how
  `monitoring_round_outcomes` is built.
- **`validateReportSort` and the Backoffice sort headers must move together.**
  A sort field added on one side only is either a dead arrow or a 400.
- **Do not hash or narrow a live dedupe key.** The monitoring admission key was
  widened to VARCHAR(512) in TASK-EAR-343 for 159-character nested Mission ids.

## Verification

- Unit tests over each new projection with a seeded ClickHouse fixture,
  including a partial-dimension row that must still report `partial_data`.
- A sort test per report type asserting the allowlist and the rejection path.
- Staging: call each `/api/v1/admin/reports/{report_type}` through
  `api-test-gateway` with a staff token and record row counts and
  `coverage_start` per type as evidence.
- Backoffice re-check on `task/TASK-EAR-291-monitoring-reports`: the four
  blocked routes should render rows without further frontend changes beyond
  the page wiring that run owns.

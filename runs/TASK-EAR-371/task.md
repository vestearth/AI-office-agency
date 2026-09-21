# TASK-EAR-371 — Publish store purchase measures for the package report

## Origin

Split out of TASK-EAR-370 track B at operator request, because this slice is
unusually well bounded: the source events are already ingested, the contract
does not change, and the result is directly visible on a page that ships today.

TASK-EAR-291 wired the package report to the API and blanked its fabricated
figures. Three header cards still read "-" because nothing publishes them, and
the table itself has no rows for the same reason.

## Type

feature

## Workstream

backend

## Goal

Publish purchase measures for the package report: the three header figures and
the per-package row measures, both from the store purchase events already in
ClickHouse.

## Scope

- `Games-Labs-Logs` — the ClickHouse aggregation and the `package` branch of
  `ListReports` in `internal/core/handlers/monitoringhdl/grpc.go`.
- Out of scope: `shared-lib` and `api-gateway`. `PackageReportSummary` already
  carries every field needed (`purchase_count`, `unique_players`,
  `coin_amount`, `diamond_amount`, `total_purchase`, `currency`,
  `package_id`, `package_name`, `package_type`, `created_at`), so this run
  changes no contract. Per TASK-EAR-370 D1-D2, catalog attributes stay with
  Order and the page composes them; Logs publishes measures only.
- Out of scope: `Games-Labs-backoffice`. The three cards and the table are
  already wired and will fill once the measures land.

## What the events already carry (verified live 2026-09-21)

`GET /api/v1/admin/monitoring/player-logs/store` on staging returns 128 events,
one shape per purchase:

```json
{"eventId":"player-activity:order:3da324f5-…:store.purchase.settled",
 "occurredAt":"2026-09-11T23:30:16Z",
 "userId":"f737e6f3-466b-4db5-b86e-70ac4772b660",
 "sourceService":"games-labs-order",
 "store":{"purchaseId":"3da324f5-…","packageId":"5fd99dcd-…",
          "packageName":"First Timer","storeType":"order",
          "amountPaid":29,"currency":"THB","paymentGateway":"PromptPay",
          "complimentary":false,"originalPrice":29,"totalDiscount":0,
          "packageDisplayType":"Custom",
          "assets":[{"type":"diamond","amount":20},{"type":"coin","amount":2400}]}}
```

Every figure the page needs is derivable:

| Target | Derivation |
|---|---|
| Purchase Count (Time) | count of `store.purchase.settled` |
| Unique Players | `uniqExact(user_id)` |
| Total Purchase (THB) | sum of `amountPaid` where currency is THB |
| per-package rows | the same three, grouped by `package_id`, plus coin and diamond amounts from `assets` |

## The one real decision: where the paid amount lives

`monitoring_player_events` types the columns this aggregation groups by —
`user_id`, `package_id`, `currency`, `event_type`, `occurred_at` — but **not**
the paid amount. `bet_amount`, `win_loss_amount` and `win_loss_thb` are
gameplay columns; `amountPaid` exists only inside the `payload String` JSON.

- **A. `JSONExtract` from `payload` at query time.** No migration, no backfill,
  works on every historical row. Costs a JSON parse per row and couples the
  query to the payload's exact shape, so a rename in the Order event breaks the
  report silently.
- **B. Add typed columns at ingest** (for example `paid_amount Float64`,
  `paid_currency LowCardinality(String)`), matching how `bet_amount` and
  `win_loss_thb` are already typed. Robust and cheap to query, but rows ingested
  before the change have no value, so it needs a backfill from `payload` or an
  explicit coverage start for the amount.
- **C. A purpose-built rollup table**, following the existing
  `monitoring_game_player_daily` precedent, populated at ingest and read
  directly. Best read performance; most work.

Recommendation was **B**. **Chosen: A**, in PR #36.

The reader already runs `JSONExtractString(payload, 'package_name')` in its
store search clause, so JSONExtract is the established pattern in this exact
file rather than a new one. It needs no migration and works on every
historical row, where B would leave rows ingested before the change without a
value until backfilled. If purchase volume ever makes the per-row JSON parse
matter, B remains available as an optimisation and the query is the only thing
that changes.

## Found while implementing (2026-09-21)

- 🔴 **The `monitoring_player_events` DDL cannot create on a fresh database.**
  It declares `TTL occurred_at + INTERVAL 365 DAY` over a `DateTime64` column,
  which ClickHouse rejects with code 450 on both 23.8 and 24.8. An existing
  table keeps working because `CREATE TABLE IF NOT EXISTS` no-ops, so staging
  never hit it — but a new environment cannot boot, and **every integration
  test in `internal/monitoring` has been failing at setup** for the same
  reason. Fixed with `toDateTime()` in PR #36, which offers to split it out.
- **`if(uniqExact(currency) = 1, any(currency), '')` is rejected by
  ClickHouse** as an aggregate inside an aggregate. It compiles and would pass
  a mocked test; only a real server catches it. The value is computed in the
  outer select instead.
- ⚠️ **This repo's `main` no longer contains the monitoring code.** `staging`
  and `prod` are the live branches; `main`'s last commit removed the logging
  handlers, repository and models. Branch from `origin/staging`. The working
  checkout was also sitting on another lane's
  `task/TASK-EAR-200-clickhouse-fail-loud` branch — check before committing.

## Constraints to honour

- **`monitoring_player_events` has `TTL occurred_at + INTERVAL 365 DAY`.** Any
  total published from it is a rolling 12-month figure, not lifetime. Either
  label it as such on the card or state explicitly that the product accepts it.
  Do not present a TTL-bounded sum as an all-time total.
- **Mixed currencies must not be summed blind.** `currency` is per row and the
  card says THB. Sum only THB rows, or convert with a recorded rate source -
  never add across currencies.
- **`complimentary` purchases and non-`order` store types.** `storeType` and
  `complimentary` distinguish a paid purchase from a granted one. Decide whether
  a complimentary row counts toward Purchase Count (it is a purchase event but
  not revenue) and keep it out of Total Purchase either way.
- **int64 measures reach the client as JSON strings.** `total` already arrives
  as `"46"` on this endpoint; counts added here behave the same.
- **`partial_data` keeps its TASK-EAR-370 meaning:** true means the rows are
  real but some columns are unavailable. An empty list must never signal a
  failure.

## Acceptance criteria

1. `ListReports` with `report_type=package` returns one item per package that
   has at least one purchase event, carrying purchase count, unique players,
   total purchase and the coin and diamond amounts, keyed by the same
   `package_id` the Order catalog returns.
2. The three package header figures are derivable from the same response
   without a second aggregation, or the run records how the page should obtain
   them. **Recorded:** the response is per-package, so the page sums across
   packages itself. It requests the package report once at the server's page
   cap and totals the rows, exactly as it already fetches the active catalog
   count separately. `ClampMonitoringPage` caps `limit` at **100**, and the
   catalog holds 17 packages today, so the sum is exact. **If the catalog ever
   passes 100 packages this silently becomes a partial total** - at that point
   the header figures need a response-level aggregate, which is a contract
   change and a new run. Note the cap in the frontend code so the limit is not
   discovered the hard way.
3. The published total states its window honestly given the 365-day TTL.
4. Complimentary and non-order store types are handled per the decision above,
   and the choice is covered by a test.
5. No contract change: `monitoringpb`, gateway artifacts and Swagger are
   untouched.

## Verification

- Unit tests over the aggregation with a seeded fixture covering: a paid
  purchase, a complimentary one, a non-THB currency, and two purchases by the
  same player (which must count twice in Purchase Count and once in Unique
  Players).
- Staging: call `/api/v1/admin/reports/package` through `api-test-gateway` with
  a staff token and reconcile the totals against
  `/api/v1/admin/monitoring/player-logs/store`, which returned 128 events on
  2026-09-21. The two must agree.
- **Open the deployed page and read it.** The package report is live at
  `admin-dev.gameslabs.app/admin/monitoring/report/package`; the three cards
  must stop reading "-" and the table must show rows. Every defect on
  TASK-EAR-291 survived the test suite, the build and review, and was caught
  only this way.
- Do not accept a zero-row result as proof. Pair any count with a package known
  to have purchases.
- A green `Build and Deploy` means the image was built and the sha pinned, not
  that it is serving — the rollout is Argo CD's and lagged about two minutes on
  2026-09-21. Re-fetch the page until the change is actually present.

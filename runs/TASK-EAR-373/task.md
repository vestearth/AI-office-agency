# TASK-EAR-373 — Publish response-level totals for the Monitoring report pages

## Origin

Raised out of TASK-EAR-371. Wiring the package report's header cards showed
that a header figure cannot always be derived on the client, and that the
problem is not limited to one card.

## Type

feature

## Workstream

backend

## Goal

Publish the report header figures from the server, computed over the whole
filtered set rather than the returned page, so the Monitoring report pages stop
showing "-" for figures that exist and never show a figure derived incorrectly.

## Why the client cannot do this

`ListReports` returns one row per entity. Some header figures are sums of those
rows and some are not.

🔴 **Measured on staging 2026-09-21, package report:**

```
sum of per-package uniquePlayers : 74
actual distinct buyers           : 11
```

`unique_players` is a distinct count **per package**, so adding it counts a
player once for every package they bought from — a 6.7x overcount on current
data. TASK-EAR-371 originally recorded "the page sums the rows" for all three
package header figures; that was corrected, and the card was left blank rather
than filled with 74.

The additive figures have a second, quieter problem: `ClampMonitoringPage` caps
a page at 100 rows, so any client-side sum is exact only while the entity count
stays under the cap. The package page currently withholds its totals entirely
if `total` exceeds what one page returned, which is honest but means the cards
go blank the day the catalog grows.

## Scope

- `shared-lib` — `proto/admin/monitoringpb/monitoring.proto`: an additive
  totals field on `ListReportsResponse`, plus regenerated artifacts.
- `api-gateway` — regenerated artifacts only.
- `Games-Labs-Logs` — compute the totals over the filtered set in the same
  query path that already produces the rows.
- `Games-Labs-backoffice` — bind the cards; remove the client-side summing
  added in PR #139 once the server figure lands.

## Cards this unblocks (verified 2026-09-21)

| Report | Cards still reading "-" |
|---|---|
| game | Total Games Round, Total Turnover (Coin), Total W/L (Coin), Total W/L (THB) |
| provider | Total Game Round, Total Turnover, Total W/L (Coin), Total W/L (THB) |
| package | Unique Players |

Nine cards across three pages. The player report's six cards are already served
by `/api/v1/admin/user/summary` and are out of scope.

## Open decision

How should the totals be shaped?

- **A. One generic message** (for example `ReportTotals` with optional
  `purchase_count`, `unique_players`, `turnover`, `win_loss`, `rounds`,
  `total_purchase`), where each report type fills the fields that apply.
  Simple and additive, but the meaning of a field varies by report type and
  unset must stay distinguishable from zero — note that the gateway runs with
  **EmitUnpopulated**, so a plain numeric field arrives as `0` whether it was
  set or not. Use `optional` (proto3 presence) or wrapper types for anything
  that can legitimately be absent.
- **B. A `oneof` mirroring the summary messages**, so `GameReportTotals`,
  `PackageReportTotals` and so on each carry exactly their own fields.
  Unambiguous and self-documenting; more proto surface.

Recommendation: **B**, because the per-type summaries already exist in this
file and a reader can then tell what a number means without cross-referencing
the report type. Record the choice and why.

## Acceptance criteria

1. `ListReportsResponse` carries totals computed over the **whole filtered
   set**, not the returned page, and they respond to search and date filters
   exactly as the rows do.
2. Distinct measures are computed with a distinct aggregate server-side. A
   test asserts that a player who appears under two entities counts once.
3. A figure the projection cannot produce is **absent**, not zero — and given
   EmitUnpopulated, absence is expressed with proto3 presence, not by sending 0.
4. The backoffice binds the nine cards listed above and drops the client-side
   summing from PR #139, including its page-cap guard, which the server figure
   makes unnecessary.
5. Contract changes are additive and wire-compatible; generated protobuf,
   gateway and Swagger artifacts are regenerated, never hand-edited.

## Deploy order

`shared-lib` (tag) → `api-gateway` (bump pin, regenerate) → `Games-Labs-Logs`
(bump pin, compute totals) → `Games-Labs-backoffice` (bind the cards). The
gateway owns the wire format, so its bump ships with the proto change.

Logs deploys from its own `staging` and `prod` branches, not `main` — `main` no
longer holds the monitoring code.

## Traps

- **EmitUnpopulated makes 0 and absent identical on the wire** for a plain
  numeric proto field. This is exactly how the game report ended up asserting
  `Point Generated 0` for a dimension it does not have (fixed in backoffice
  PR #136 behind `PUBLISHED_DIMENSIONS`). Do not repeat it for totals.
- **int64 reaches the client as a JSON string.** `total` already arrives as
  `"26"` on this endpoint; every count added here behaves the same.
- **Do not sum across currencies.** `total_purchase` is THB-only by decision in
  TASK-EAR-371; a totals field must carry the same rule and say so.
- **The 365-day TTL on `monitoring_player_events` still applies**, so any
  published total remains a rolling 12-month figure, not lifetime.
- **`Games-Labs-Logs` and `Games-Labs-backoffice` checkouts are shared with
  other lanes.** Both were found on another lane's branch during TASK-EAR-371,
  and a bare `git stash` captured that lane's uncommitted work. Use a worktree
  under `.worktrees/`.

## Verification

- A Logs test per report type asserting the totals match a hand-computed
  fixture, including the distinct case from acceptance criterion 2.
- Staging: call `/api/v1/admin/reports/package` and confirm the published
  unique-players total is **11**, not 74, against the same data that produced
  those numbers on 2026-09-21. Reconcile the purchase count against the 128
  events in `/api/v1/admin/monitoring/player-logs/store`.
- **Open the deployed pages and read the cards.** Every defect on this epic so
  far passed the test suite, the build and review, and was caught only by
  looking at a rendered page.
- A green `Build and Deploy` means built and pinned, not serving. The backoffice
  rollout is Argo CD's and lagged about two minutes on 2026-09-21; re-fetch
  until the change is present.

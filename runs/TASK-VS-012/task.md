# TASK-VS-012 — Restore admin Overview dashboard

## Context

On 2026-09-29, the production Overview dashboard displayed `—` for every KPI. Production `slip-api` logs showed repeated 500 responses for admin verification and credit transaction history, typically near the 3-second repository query timeout. The `slip-admin` dashboard used one `Promise.all` for 15 API requests, so any failure hid every KPI.

## Goal

Show data from successful admin APIs when one source fails, and restore timely admin history queries.

## Scope

- `slip-admin`: Overview dashboard request handling and partial failure display.
- `slip-admin`: align seven-day chart buckets and Today/30-day query boundaries with the existing Asia/Bangkok date utilities.
- `slip-api`: additive, concurrent indexes for unfiltered and status-filtered admin verification history and global credit transaction history; migration file-count expectation.
- Preserve endpoint responses, authentication, and pagination contracts.

## Acceptance Criteria

- With verification and credit history returning 500, successful merchant and branch KPIs remain visible; failed KPIs show `—`.
- The seven-day chart includes the current Bangkok day, and a slip created today appears in today's bucket; Today/30-day queries start at Bangkok midnight.
- Existing API routes retain their request and response shapes.
- Admin build and targeted backend tests pass.
- After the `main` → `staging` → `prod` promotion, authenticated production Overview loads and affected API routes no longer time out at the observed workload.

## Completion Summary — 2026-09-29

- `slip-admin` partial dashboard loading and Bangkok-day boundaries merged through PRs #4–#8. `slip-api` history indexes and ledger query optimization merged through PRs #31–#36.
- Production deployment workflows succeeded: [admin](https://github.com/SparqLab/slip-admin/actions/runs/36518800967) and [API](https://github.com/SparqLab/slip-api/actions/runs/36520652124). ECS is steady on `slip-admin-production:30` (1/1) and `slip-api-production:51` (3/3).
- Authenticated production Overview reloaded at 12:02 Bangkok with all KPI values and the current day populated. Checks Today was 52,807; the daily chart showed 100 verified recent-row samples for 09-29.
- After the ledger query rollout, two production first-page credit-transactions calls returned HTTP 200 in 12 ms and 20 ms. Existing Go tests and admin builds passed; latest ECS evidence is in `evidence.yaml` (`ev-005`, `ev-006`).
- The seven-day chart remains a sample of recent rows, so it does not represent full-range daily totals.

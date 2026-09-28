# TASK-VS-008 — Branch page "ตรวจสลิปเดือนนี้" shows API 0 · LINE 0

## Why

Operator screenshot (2026-09-26, prod, merchant O2p, branch 5G): the tile "ตรวจสลิปเดือนนี้" shows 38,944, but the
hint shows "API 0 · LINE 0". The branch's API channel has used 38,061.

## Findings (verified 2026-09-27 on origin/main of both repos)

- The FE reads `month.api ?? month.checks_api` and `month.line ?? month.checks_line`
  (`slip-front-end/app/features/branches/map.ts` `mapKpiTiles`).
- slip-api `BranchOverviewMonth` (`internal/models/branch.go`) has only total/success/failed/duplicate/
  receiving_accounts. It has no per-channel field, so the FE reads undefined and shows 0.
- `branch.GetOverview` (`internal/core/service/branch.go`) already calls `reports.Usage` for the month. That result
  carries `ByChannel`, but the service never copies it over.

## Scope

Backend only: add `api` and `line` to `BranchOverviewMonth`, filled from `usage.ByChannel`. This is an additive JSON
field. No FE change, since the FE already reads `month.api` / `month.line`. No schema change.

## Tests

RED: a service test showing that GetOverview's month.API/LINE equal the seeded per-channel counts (currently 0).

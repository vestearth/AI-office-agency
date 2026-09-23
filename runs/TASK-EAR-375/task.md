# TASK-EAR-375 — Player Log Redemption search matches Item name

## Origin

Follow-up from TASK-EAR-372 / TASK-EAR-374 smoke on
`admin-dev.gameslabs.app/admin/monitoring/player-log/redemption` (2026-09-21).
Unfiltered list showed item `test5DMD-2026092`. Search `test5DMD` called
`GET /api/v1/admin/monitoring/player-logs/redemption?search=test5DMD` and
returned 0 of 0. Backoffice only forwards `search`; the miss is in Logs.

## Type

bugfix

## Workstream

backend

## Priority

medium

## Parent

TASK-EAR-372

## Goal

Player Log Redemption search must match the visible Item column
(`redemption_item_name` in the ClickHouse payload). Keep Store
`package_name` search working. Do not put voucher codes or redeem links
into the search clause.

## Scope

| Service | Why |
|---|---|
| `Games-Labs-Logs` | `buildMonitoringWhere` omits redemption identity fields |

Out of scope: live catalog join, voucher codes/links, redemption report page,
ClickHouse schema, other log types except additive shared-WHERE fields that
do not change Store `package_name` behavior, `Games-Lab-Android/`, prod ECS/RDS.

## Evidence

`Games-Labs-Logs/infrastructures/monitoring_clickhouse.go` `buildMonitoringWhere`
search clause (current):

```
user_id ILIKE
OR source_reference_id ILIKE
OR package_id ILIKE
OR mission_id ILIKE
OR JSONExtractString(payload, 'package_name') ILIKE
```

Event JSON already has `redemption_item_name` (`shared-lib/events/player_activity.go`).
The typed column `redemption_item_id` is selected but not searched.
`TestBuildMonitoringWhereSearchesPackageName` currently requires exactly 5
placeholders.

## Acceptance

1. Searching a substring of a visible Redemption Item name (repro:
   `test5DMD` vs `test5DMD-2026092`) returns that row.
2. Store search still matches `payload.package_name`.
3. Search still does not match assigned voucher codes or redeem URLs.
4. A Logs unit test covers `redemption_item_name` (and `redemption_item_id`
   if that column is added to the clause) without dropping the existing
   `package_name` assertion.
5. Smoke the deployed Player Log Redemption search box after Logs staging
   deploy; do not treat a green build as serving.

## Plan

Extend the existing search OR list with:

- `redemption_item_id ILIKE ?`
- `JSONExtractString(payload, 'redemption_item_name') ILIKE ?`

Update `TestBuildMonitoringWhereSearchesPackageName` (placeholder count
will rise) and keep the `package_name` substring check.

PR target: `Games-Labs-Logs` → `staging`. Use a worktree under `.worktrees/`
if the Logs checkout is on another lane's branch.

## Traps

- Do not join `redemption_items` at query time. Search the snapshot only.
- Do not search payload keys that could hold a voucher code.
- `Games-Labs-Logs` deploys from `staging` / `prod`, not `main`.
- Prod ECS stays desired 0 unless the operator explicitly pays for it.

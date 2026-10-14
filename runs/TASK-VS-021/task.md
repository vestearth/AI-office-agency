# TASK-VS-021: Overview month slip counts via one cached summary endpoint instead of 5 month-wide COUNTs

## Symptom (from TASK-VS-020)
slip-admin Overview, month scope, fires 5 parallel `GET /v1/admin/verifications?from=<month start>&limit=1`
(month total + verified/rejected/not_found/duplicate) only to read `total_items`. Each runs a
month-wide `COUNT(*)` (CountAll, 10s floor). Prod 2026-10-14 04:47:26Z: 500 after 10001ms,
`count verifications: timeout: context deadline exceeded` (TASK-VS-020 ev-005). 200s at 9.6s were seen too;
the cost grows daily until month end.

## Fix
- slip-api SparqLab/slip-api#62: `GET /v1/admin/verifications/summary?from=YYYY-MM-DD&to=YYYY-MM-DD`
  (admin) returns total/verified/rejected/not_found/duplicate over Bangkok days, using one grouped query
  (`AdminStatusCountsByDay`). Closed days (ended more than 5 min ago) are cached in process: verification rows
  never change status/created_at after insert (the only UPDATE touches idempotency_key) and nothing deletes them.
  Only open days are scanned per call. `to` is clamped to today; 93-day cap.
- slip-admin SparqLab/slip-admin#12: Overview uses the summary for the month KPI + status breakdown
  (shared call on month scope). UI unchanged.

## Deploy order
slip-api#62 must be on an environment before slip-admin#12; otherwise the month KPIs show "—" (404).
Rollback: revert slip-admin first, then slip-api (the endpoint is additive).

## Out of scope / follow-ups
- slips page (SlipsManage) status counts: 5 list calls with no date bound = whole-table COUNTs.
- `admin_bank_flow_summary` 15s timeouts (month preset).
- ListAll 3s vs CountAll 10s timeout mismatch on /v1/admin/verifications.

## Acceptance
- Staging: Overview loads with `admin_verification_summary` 200s and no `admin_verification_list` month calls.
- Prod: month filter no longer produces `count verifications ... deadline exceeded`; summary latency is low
  after the first fill per task.

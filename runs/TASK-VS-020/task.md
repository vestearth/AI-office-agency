# TASK-VS-020: Log real error behind slip-api reports 500 and stop mapping client cancel to 500

## Symptom
Prod slip-api `GET /v1/admin/verifications` returns 500 `request failed` in pairs
when slip-admin Overview loads with the **month** scope. Example: 2026-10-14
04:00:29Z, request_id `a785135db8e4a17275679f2dd73586fa` (4783ms) +
`78fb34b80060b513c7ef7673a1313516` (4731ms). Overview fires 6 parallel
`/v1/admin/verifications?from=<month start>&limit=1` (today, month, 4 statuses);
4 returned 200 and 2 returned 500 at the same millisecond on different ECS tasks.
Another pair: 03:40:44Z (1824/1999ms).

## Root-cause gap
`writeReportsError` (slip-api `internal/handler/http/reports.go`) answered every
unmapped error with 500 and dropped `err`, so these candidates cannot be told apart:
1. client went away mid-query (request ctx cancelled), suspected from the
   simultaneous pair endings followed by a fresh page load
2. `ListAll` 3s timeout (`cmd/main.go` queryTimeout) while `CountAll` (10s floor)
   is still running
3. `CountAll` month-wide COUNT(*) hitting 10s (already seen at 9.6s with a 200)

## Scope (this run = item 1 only)
- Log the underlying error (request_id, method, path, error) on the reports 500 path.
- Request ctx cancelled → 408 `request canceled` + WARN (same mapping as bank.go).
- Server-side deadlines and other errors stay 500.

## Out of scope (follow-ups)
- Make the ListAll timeout match CountAll.
- Replace the 5 month-wide COUNTs on the overview with one grouped query.
- `admin_bank_flow_summary` hitting its 15s timeout (`repositories/bank_flows.go:77`).

## Acceptance
- RED on main, GREEN on branch for `internal/handler/http/reports_error_test.go`.
- After deploy: an admin_verification_list 500 has a matching
  `"reports request failed"` line with the same request_id and real error text.

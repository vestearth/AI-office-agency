# TASK-VS-010 — Bank transfer times shown +7h in admin

## Problem
admin.up-slip.com Transfers table shows KBANK slips 7 hours late (ref
`016271173003ATF03904` = 17:30 Bangkok is displayed as 29 ก.ย. 00:30).

## Root cause
`slip-api/internal/models/verification.go` `bankTransDatetime` joins KBANK
`transDate` + `transTime` (Bangkok wall-clock) and parses with `time.Parse`
(UTC), then stores `...Z`. The admin UI (fixed in slip-admin a51e82b to
render Asia/Bangkok) correctly shifts that bogus UTC instant +7h.

## Scope
- Parse KBANK date+time in Asia/Bangkok before formatting RFC3339 UTC.
- Regression test seen failing before the fix.
- Existing `verifications.trans_datetime` rows are wrong; backfill is an
  operator decision (not shipped without approval).

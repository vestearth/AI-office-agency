# TASK-VS-007 — Verification page KPI tiles capped at 1,000

## Why

Operator report (2026-09-26, prod, merchant O2p, branch 5G): the customer used 38,000+ checks, but the
"ตรวจสอบสลิป" page shows "รายการตรวจวันนี้ 1,000", and the table shows "แสดง 1–20 จาก 1,000 รายการ".
The branch page shows 38,061 / 320,000 used.

## Findings (verified 2026-09-26 on slip-front-end 719e813 = origin/main)

- All four stat tiles come from `summarizeVerifications(allRows)` (`app/features/verification/utils.ts:582`),
  counted client-side over the rows the page loaded.
- Loading stops after `verificationHistoryLimit (100) × verificationHistoryMaxPages (10)` = 1,000 rows per branch
  (`constants.ts:52-54`, `composables/useVerificationList.ts:219-236`).
- The screenshot matches the cap exactly: token 975 + duplicate 25 = 1,000.
- slip-api list `total_items` is not a real count (`pageTotal(offset, len, hasMore)`), so the FE cannot use it as a total.
- slip-api `GET /v1/usage` already aggregates in SQL: total, by_status, by_channel (same filters: merchant_id,
  branch_ids, from, to). It does not break down outcome_reason, so receiver_mismatch cannot be counted.

## Scope

1. **Backend (slip-api):** `UsageByUser` also groups by outcome_reason. `UsageReport` gains `by_outcome_reason`
   (additive field, backward compatible). No schema change.
2. **Frontend (slip-front-end):** the stat tiles use server aggregates from `/v1/usage` (range for the bank and
   attention tiles, today for the today and token tiles). If the call fails, fall back to the client summary.
   The table total label uses the server total when the loaded rows are truncated.

Mapping (keeps the existing FE semantics): confirmed = verified + duplicate; not_found = not_found;
no_response = statuses outside verified/rejected/not_found/duplicate; attention = duplicate + receiver_mismatch;
tokens = verified + rejected + not_found (duplicates are not charged).

Out of scope, follow-up: true server-side pagination for the table (it still shows only the newest 1,000 rows per
branch). Branch page "API 0 · LINE 0" under 38,944 is a separate bug.

## Tests

- Backend RED: usage service/repo test that a verified row with receiver_mismatch appears in `by_outcome_reason`.
- Frontend: no test runner in slip-front-end (known blocker since TASK-VS-006); eslint + nuxt typecheck.

# TASK-VS-047: Branch package detail/overview/API channel must not 500 when usage aggregation times out

Production incident on 2026-10-25. A high-volume merchant could not renew its package from the merchant app (`app.up-slip.com`), so its slip verification stayed down.

**Scope (Earth, 2026-10-25):** hotfix in slip-api only. If `reports.Usage` errors in `GetPackage`, `Overview` or `GetChannel` (api and line), log the error and return the view with empty usage, plus a regression test. The long-term query fix is out of scope (see Follow-ups).

## Symptom

- Merchant `84006774-abc7-4a1b-8af1-20decab2c30a`, branch 5G `816d9bc9-76f1-4817-89ee-e86dbe5deb2c` (code 783601), Enterprise API package with 320,000 quota.
- The branch sends about 400 verifies per minute. That is nearly all of production traffic: about 25k of the ALB's roughly 25k requests per hour.
- **13:12 Bangkok (06:12:15Z):** quota ran out. From then on every `POST /v1/slips/verify` and `/v1/slips/decode` call returned **403 "no active package"**. In the 14:00–14:10 window, 4,188 of 4,194 calls were 403; in the same window the day before, 4,098 calls returned 200.
- **Package page:** the merchant clicked "ต่อายุแพ็กเกจเดิม". The modal opened as an empty dark overlay ("ค้าง").
- **Branch page** (`/branches/...`): it showed "โหลดภาพรวมไม่สำเร็จ" and "โหลดช่องทาง API ไม่สำเร็จ". The auto-renew toggle showed "บันทึกการต่ออายุไม่สำเร็จ".
- No renew request (`PUT /v1/branch-packages/{id}` or `POST /v1/packages/purchase`) from this merchant ever reached slip-api.

## Root cause

- Three merchant read endpoints call `reports.Usage`:
  - `GET /v1/merchants/{m}/branch-packages/{id}` (`GetPackage`)
  - `GET .../branches/{id}/overview` (`Overview`)
  - `GET .../branches/{id}/channels/{api|line}` (`GetChannel`)
- `reports.Usage` runs `verificationRepository.UsageByUser`. That query is a `GROUP BY` over every `verifications` row of the branch for 30 days or the month to date. This branch writes about 590k rows per day.
- The query outruns the 3s repository `queryTimeout` (`cmd/main.go:83`). The service treated any non-forbidden Usage error as fatal, so the whole endpoint returned 500 "branch request failed" after about 3,000 ms.
- slip-front-end needs the package detail to render the renew modal: `PackagePage.vue` has `v-if="selected && selectedDetail && canRenewNow()"`. On the branch page, the subscription id comes from the failing reads. Renewal was therefore unreachable from the UI. The renew API itself (`POST /v1/packages/purchase`) answers in about 27 ms.
- **Why the package stopped (inferred from code, not checked against the ledger):** `renewal_failed` is only recorded on `ErrInsufficientBalance` in `consumeQuotaInTx`. Auto-renew-on-quota therefore likely failed for lack of credit at 13:12, and the merchant topped up later; the balance now shows 1,020,027.

## Evidence

- **ev-004:** production `slip-api` 5xx for merchant `84006774-…` from 15:00–18:00 Bangkok. Every request to `overview`, `branch-packages/{id}` and `channels/api` returned 500 after about 3,000–3,400 ms. Other merchants' overview calls answered in 40–80 ms in the same window, observed during the investigation.
- **Investigation (not in the ledger):**
  - 24h 5xx census: every merchant-route 5xx (96 of 96) was this merchant.
  - Verify-volume windows were counted from `/ecs/slip-api-production`.
  - First 403 was at 06:12:15Z.
  - RDS CPU stayed at 6–9 %, so this is not a database-wide overload.

## Fix

- Branch `task/TASK-VS-047-usage-timeout-nonfatal` on slip-api, cut from `origin/main` `3a00e07`, which equals prod `1ee6fa3` code.
- Worktree: `.worktrees/slip-api-TASK-VS-047`.
- Commit `0bc4c41`; PR https://github.com/SparqLab/slip-api/pull/86 into `main`, opened 2026-10-25. slip-api runs no checks on pull requests, so the PR shows zero checks.
- `internal/core/service/branch.go`: at all 7 `reports.Usage` call sites, the error now goes to a new `logUsageUnavailable` helper and the existing empty-usage default stays in place:
  - `GetPackage`
  - `Overview` month and week
  - API channel today, week and month
  - LINE channel month
- The helper writes `slog.Default().WarnContext(ctx, "branch usage unavailable", "view", …, "branch_id", …, "error", …)`. `ErrForbidden` stays silent, exactly as before.
- `Overview.ListVerifications` is unchanged; its 5-row indexed query was never seen failing.

## Verification

- **ev-001 (RED):** untouched `origin/main` `3a00e07` plus the new test file only. All 4 tests in `branch_usage_degrade_test.go` FAIL with `usage: usage verifications: context deadline exceeded`.
- **ev-002 (GREEN):** fix applied. The 4 new tests and the existing `TestOverviewMonthCountsPerChannel` PASS. The tests also assert that the failure is logged.
- **ev-003:** `go vet ./... && go build ./...` pass. `go test ./...` passes in every package except `migrations` `TestGooseSQLFiles`.
- **ev-005:** that migrations failure is pre-existing on untouched `origin/main`: "want 63", but there are 64 files. Migration `064_user_session_version.sql` came from `2e303ea` without updating the count. Not touched here; this is a separate fix for the slip-api owners.
- **Not yet verified:** that the deployed fix lets this merchant open the renew modal on `https://app.up-slip.com/branches` and the package page.

## Follow-ups (not in this task)

- Usage aggregation must stop scanning raw `verifications` for high-volume branches. Options are a daily rollup table or at least a covering index. `/v1/usage`, `/v1/usage/monthly`, `/v1/branch-packages/history` and `dashboard/summary*` still 500 for this merchant for the same reason.
- slip-front-end: the renew modal could fall back to the list row when the package detail is unavailable.

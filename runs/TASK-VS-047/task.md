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
- `Overview.ListVerifications` is unchanged. **Correction (after the prod deploy):** an earlier version of this note said its 5-row query was never seen failing. That was wrong. `reports.ListVerifications` also runs `CountByUser`, a `COUNT(*)` over the whole range with a 10s timeout floor. That count times out on this branch, so overview still returns 500 (see Deploy).

## Verification

- **ev-001 (RED):** untouched `origin/main` `3a00e07` plus the new test file only. All 4 tests in `branch_usage_degrade_test.go` FAIL with `usage: usage verifications: context deadline exceeded`.
- **ev-002 (GREEN):** fix applied. The 4 new tests and the existing `TestOverviewMonthCountsPerChannel` PASS. The tests also assert that the failure is logged.
- **ev-003:** `go vet ./... && go build ./...` pass. `go test ./...` passes in every package except `migrations` `TestGooseSQLFiles`.
- **ev-005:** that migrations failure is pre-existing on untouched `origin/main`: "want 63", but there are 64 files. Migration `064_user_session_version.sql` came from `2e303ea` without updating the count. Not touched here; this is a separate fix for the slip-api owners.
## Deploy (2026-10-25, operator-approved)

- **Merge and promotion:** PR #86 merged into `main` (`36c1e8a`). PR #87 promoted `main` → `staging` (`4b0793a`). PR #88 promoted `staging` → `prod` (`f106243`).
- **Before merging:** `main`, `staging` and `prod` carried no other pending commits. PR #88's merge-base diff contained only the 2 hotfix files. The prod-only `ecs/task-definition.production.json` was kept.
- **Staging:** Deploy STAGING run `40182855347` succeeded, and `slip-api-staging:152` runs `staging-sha-4b0793a`.
  - The new task booted at 10:01:17Z, the ALB target is healthy, and staging logged no ERROR or panic.
  - The changed endpoints were **not** exercised on staging, because that needs a merchant JWT.
- **Prod:** Deploy PRODUCTION run `40183682573` succeeded. `slip-api-production:109` runs `production-sha-f106243` with 3 of 3 tasks; the rollout completed at 10:21:11Z and all 3 targets are healthy.
- **Rollback:** `slip-api-production:108` (`production-sha-1ee6fa3`).
- **ev-006:** prod log for merchant `84006774-…` on the new tasks, 10:17–10:22Z:

  | Endpoint | Before | After |
  |---|---|---|
  | `GET …/branch-packages/{id}`, which the renew modal needs | 500 | **200** in about 3,020 ms |
  | `GET …/branches/{id}/channels/api` | 500 | **200** in about 6,430 ms |
  | `GET …/branches/{id}/overview` | 500 | **still 500**, now after about 16,000 ms |

  - The overview time is Usage 3s + 3s + `CountByUser` 10s.
  - The new code ran: `branch usage unavailable` warnings were logged for `api_channel_week`, `api_channel_month`, `overview_month` and `overview_week`.
- **Still open at 10:22Z:**
  - No `POST /v1/packages/purchase` from this merchant yet.
  - Verifies are still 403 "no active package" (162 in the last 2 minutes).
  - Renewal now depends on the merchant clicking renew on `https://app.up-slip.com`, from the package page or the branch page.

## Fix 2: overview recent list (Earth, 2026-10-25)

- Branch `task/TASK-VS-047-overview-recent-nonfatal`, cut from `origin/main` `36c1e8a` (which contains #86).
- Commit `86126f3`; PR https://github.com/SparqLab/slip-api/pull/89 into `main`, MERGEABLE.
- In `Overview`, a `ListVerifications` error now goes to `logUsageUnavailable` (view `overview_recent`), and `Recent` stays empty. The helper's doc comment now covers this case; the log message is unchanged.
- Expected on prod after deploy: overview for this branch returns 200 after about 16s (3 + 3 + 10s), under the 20s `WriteTimeout`.
- **Evidence:**
  - **ev-007 (RED):** `origin/main` `36c1e8a` plus the updated test only. `TestOverviewLoadsWhenRecentVerificationsTimeOut` FAILS with `count verifications: context deadline exceeded`.
  - **ev-008 (GREEN):** all 6 degrade and overview tests PASS.
  - **ev-009:** vet and build pass. The full suite passes except the pre-existing `migrations` failure (ev-005).
- **Not done yet:** merge #89 and promote main→staging→prod. Each step needs Earth's go-ahead.

## Follow-ups (not in this task)

- Overview still pays for a full `COUNT(*)` it does not display. Letting overview skip the count would bring it back to seconds.

- Usage aggregation must stop scanning raw `verifications` for high-volume branches. Options are a daily rollup table or at least a covering index. `/v1/usage`, `/v1/usage/monthly`, `/v1/branch-packages/history` and `dashboard/summary*` still 500 for this merchant for the same reason.
- slip-front-end: the renew modal could fall back to the list row when the package detail is unavailable.

# TASK-VS-049: GET /v1/branch-packages/history must return a bounded page, not every quota deduction (500 on high-volume merchant)

Follow-up to the 2026-10-25 production incident (TASK-VS-047, TASK-VS-048). TASK-VS-047 made package detail, overview and channels non-fatal. TASK-VS-048 (SparqLab/slip-api#92) moves usage and dashboard aggregations onto an hourly rollup. The branch quota ledger is the remaining 500, and it is a different defect: an unbounded list, not an aggregation.

## Symptom

- `GET /v1/branch-packages/history` returns 500 "package request failed" for merchant `84006774-abc7-4a1b-8af1-20decab2c30a` after about 3.0s.
- Production `/ecs/slip-api-production` logged 10 × `list quota deductions: list quota deductions: timeout: context deadline exceeded` between 2026-10-25T08:07:50Z and 17:02:27Z (filter-log-events, 48h window, pulled 2026-10-26).
- slip-front-end hides it: `useBranchUsage` (`app/features/branches/composables/useBranchTabData.ts:127`) does `packageApi.history(...).catch(() => [])`, so the branch usage tab shows "ไม่มีประวัติโควตาในช่วงที่เลือก" instead of an error.

## Root cause

- `packages.ListHistory` (`internal/core/service/package.go:278`) calls `BranchPackageRepository.ListQuotaDeductions` (`internal/repositories/branch_package.go:977`).
- That query returns every `quota_history` row with `quota_delta < 0` for the merchant or branch. It has no LIMIT and no date range.
- The verify fast path (`consumeQuotaFastPath`) writes one `quota_history` row per charged verification. Branch `816d9bc9-76f1-4817-89ee-e86dbe5deb2c` adds about 590k rows a day.
- The query outruns the 3s repository timeout.
- `mergeQuotaHistory` then merges the result in memory with grant events from `branch_package_events`, which is a small table.

## Consumer (slip-front-end `origin/main` `c3dc067`)

- Only `BranchDetailUsage.vue` uses it, through `useBranchUsage` → `packageApi.history({merchantId, branchId})`. `branch_id` is always set.
- The FE downloads the whole ledger, then filters on the client by month (this month / last month / all) and by channel. It pages 6 rows at a time with `UPagination`, shows "แสดง x–y จาก N รายการ", and exports CSV from the full filtered list.
- `mapBranchPackageHistory` (`app/features/packages/map.ts:330`) accepts either a bare array or `{items: [...]}`.
- `branchApi.quotaHistory` is a stub that returns `[]`, so the ledger comes only from this endpoint.

## Contract decision

Pending Earth. See `decision-memo.md`.

## Acceptance

- The endpoint stays under the repository timeout for a branch with millions of `quota_history` rows. Every query has a LIMIT and walks an index.
- A regression test is seen failing before the fix and passing after it.
- `go vet ./...`, `go build ./...`, and the full repository test suite pass on the PR commit (`SLIP_API_REPOSITORY_TEST_DSN`).
- A PR is open into slip-api `main`. It is not promoted; Earth approves staging and prod.

## Staging (2026-10-26, Earth-approved; prod not in scope)

- API: PR SparqLab/slip-api#94 → staging `c5e5c45` (with TASK-VS-048); Deploy STAGING run `40223217376` success, `slip-api-staging:154`, healthy.
- FE: PR SparqLab/slip-front-end#12 (main `853246a`, ci success → staging `721b542`); Deploy STAGING run `40223235711` success, `slip-front-end-staging:105` runs `staging-sha-721b542`, rollout COMPLETED.
- Smoke without auth: `app-staging.up-slip.com/branches` → 302 to `/login` (200); `api-staging.up-slip.com/health` 200; `GET /v1/branch-packages/history` without a token → 401.
- **Not exercised on staging:** the paged history with a merchant token and the branch usage tab in a browser (no staging test account was used).

## Prod (2026-10-26, Earth-approved)

- API: PR SparqLab/slip-api#95 → prod `32cd203`, `slip-api-production:111`, healthy. FE: PR SparqLab/slip-front-end#13 (staging `721b542` → prod `b3b5948`), Deploy PRODUCTION run `40227527006` success, `slip-front-end-production:65` runs `production-sha-b3b5948`, `app.up-slip.com/login` 200. Rollback: `slip-api-production:110`, `slip-front-end-production:64`.
- **ev-011:** `GET /v1/branch-packages/history` 200 in 5–26 ms (×21) at 20:31–20:34Z while Earth opened merchant `84006774`'s branch pages (was 500 after ~3 s). The history log lines carry no merchant id; they arrived with that merchant's page loads.

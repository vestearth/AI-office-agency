# TASK-VS-014 — Show full daily verification totals on Admin Overview

## Problem
The seven-day Daily volume chart counts only the first page of recent verification rows. The API caps that page at 100 items, so older days can show zero despite real checks. The screenshot on 2026-09-30 showed 100 sampled rows beside a Checks Today total of 41,745.

## Scope
- `slip-api`: add a read-only, admin-authenticated seven-day daily count endpoint grouped by Asia/Bangkok calendar date and verification status, without changing the existing history endpoint.
- `slip-admin`: use the aggregate for the Daily volume chart; preserve the existing KPI and recent-history requests.
- Verify date boundaries, status buckets, auth, empty days, and build/test results locally. Production deployment and authenticated runtime acceptance are separate.

## Acceptance
- Every seven-day bar reflects all matching verifications, independent of history pagination.
- Counts use Asia/Bangkok dates and include zero-count days.
- Existing `GET /v1/admin/verifications` response and Checks Today / 30d KPI behavior remain compatible.

## Local implementation and verification (2026-09-30)
- Added `GET /v1/admin/verifications/daily`, an admin-authenticated aggregate over the current seven Bangkok calendar days. It returns seven ordered dates, with `total`, `verified`, `rejected`, and `other` counts. The existing history endpoint and KPI queries remain in place.
- Admin Overview now reads this aggregate for Daily volume. English/Thai labels describe full daily totals. API README and Postman collection document the route.
- `go test ./internal/...` passed (`ev-001`), `go build ./...` passed (`ev-002`), `npm run build` in slip-admin passed (`ev-003`), and the PostgreSQL timezone/boundary integration test passed against a temporary local PostgreSQL 16 container (`ev-004`). The container was stopped afterward.
- The first `go test ./...` failed `migrations/TestGooseSQLFiles`: the assertion expected 48 SQL files, while `origin/main` already contained 49. Review corrected that stale expectation to 49 without removing migration checks; `go test ./...` then passed.
- Implementation PR target was `main` in both repos; production acceptance was a separate gate.

## Local review
- API route uses admin authentication; the repository query scans the bounded seven-day range and groups by Bangkok calendar date. The service fills empty days and returns seven ordered dates. The existing `verifications_created_id_idx` supports the timestamp filter; production latency was not measured during local review.
- Admin reads the aggregate only for Daily volume; the Checks Today / 30d KPI and recent-history requests are unchanged. Deploy the API before the Admin build so the new chart endpoint is available.
- Review found no blocking issue in the local daily-volume diff. On 2026-09-30, `go test ./...`, `go build ./...`, `npm run build`, `git diff --check` in both repos, and `ruby ai-dev-office/validate-yaml.rb TASK-VS-014` passed. The prior PostgreSQL boundary test remains recorded as `ev-004`; it was not rerun in this review because its temporary database had been stopped.
- Local code and build verification passed before publication; production query latency and live chart totals were separate acceptance gates. API deployment was sequenced before Admin.

## PR publication (2026-09-30)
- `slip-api` commit `95407ab` was merged into `main` by [PR #40](https://github.com/SparqLab/slip-api/pull/40) at `d00f6af`.
- `slip-admin` commit `a7b3299` was merged into `main` by [PR #9](https://github.com/SparqLab/slip-admin/pull/9) at `750df50`.
- Both implementation branches were clean after push; `gh pr view` reported no status checks at the time of publication.

## Staging promotion (2026-09-30)
- [slip-api PR #41](https://github.com/SparqLab/slip-api/pull/41) promoted `main` to `staging` at `92dc61d`; [Deploy STAGING run 36663781269](https://github.com/SparqLab/slip-api/actions/runs/36663781269) succeeded. ECS `slip-api-staging:96` completed rollout at desired/running 1/1. The new unauthenticated route responds 401 (it previously responded 404).
- [slip-admin PR #10](https://github.com/SparqLab/slip-admin/pull/10) promoted `main` to `staging` at `7fe05a2`; [Deploy STAGING run 36664264612](https://github.com/SparqLab/slip-admin/actions/runs/36664264612) succeeded. ECS `slip-admin-staging:42` completed rollout at desired/running 1/1; the Admin page responds 200.
- Authenticated staging Overview was checked after operator sign-in at 10:42 ICT: the seven bars cover 2026-09-24 through 2026-09-30, including zero-count days; 2026-09-30 shows 15 verified + 2 rejected + 2 other = 19, matching `Checks Today = 19`. The hint reads "All slip checks, grouped by Bangkok date." This confirms the deployed chart rendered the aggregate and same-day KPI consistently at this point in time; it is not a production or latency claim.
- Before production promotion, `slip-api` had 3/3 tasks on `slip-api-production:55`, and `slip-admin` had 1/1 on `slip-admin-production:31`. A direct staging-to-prod API comparison displayed pre-existing branch drift in `.github/workflows/deploy.yml` and `ecs/task-definition.production.json`, but `git merge-tree --write-tree origin/prod origin/staging` confirmed the actual merge preserved both prod-only files/contents and changed only the 16 task files. The simulated Admin merge changed only its five task files.

## Production promotion prepared (2026-09-30)
- Created clean `promote/TASK-VS-014-prod` branches by merging current `staging` into current `prod` separately in each repo. The API merge preserves prod-only workflow and task definition contents; the PR diff contains only 16 TASK-VS-014 API files. The Admin PR diff contains only its five TASK-VS-014 files.
- `go test ./...`, `go build ./...`, and `git diff --check origin/prod HEAD` passed on the API promotion tree. `npm run build` and the diff check passed on the Admin promotion tree.
- [slip-api PR #42](https://github.com/SparqLab/slip-api/pull/42) and [slip-admin PR #11](https://github.com/SparqLab/slip-admin/pull/11) were prepared as draft `prod` PRs, then marked ready and merged after authenticated staging acceptance, API first.
- Staging UI acceptance above cleared the draft gate. [slip-api PR #42](https://github.com/SparqLab/slip-api/pull/42) was merged into `prod` at `2b11e54`; [slip-admin PR #11](https://github.com/SparqLab/slip-admin/pull/11) was merged afterward at `427fd11`.

## Production deployment and acceptance (2026-09-30)
- [slip-api Deploy PRODUCTION run 36665676394](https://github.com/SparqLab/slip-api/actions/runs/36665676394) and [slip-admin Deploy PRODUCTION run 36666051625](https://github.com/SparqLab/slip-admin/actions/runs/36666051625) both completed successfully. ECS reports one completed deployment per service: `slip-api-production:56` desired/running 3/3 and `slip-admin-production:32` desired/running 1/1, with no pending tasks.
- The API route changed from 404 before rollout to 401 without an admin token after the new API tasks became healthy. The authenticated production Overview at 10:51 ICT displayed the new Bangkok-date hint and seven bars for 2026-09-24 through 2026-09-30, including a zero day. Prior days have full counts rather than the old 100-row sample zeros.
- At that reload, the 2026-09-30 bar showed 49,800 verified + 463 rejected + 956 other = 51,219, matching `Checks Today = 51,219`. The existing 30-day KPI and recent slip list rendered. One production API access-log observation for `admin_verification_daily` returned HTTP 200 in 727 ms; this is one request, not a latency percentile or sustained-load proof.
- Local Go full suite/build and Admin build passed on the exact production promotion merge trees before push. Production authentication, deployment, and one observed chart/API response are accepted at this point in time. No long-window performance trend or historical aggregate reconciliation against a direct database count was measured.

## Production aggregate cross-check (2026-09-30, 11:06 ICT)
- On a fresh authenticated Overview load, the seven daily bars (2026-09-24 through 2026-09-30) summed to 601,927 verified, 2,092 rejected, and 15,995 other = 620,014 total. Independent Overview history-count requests showed 601,927 verified, 2,092 rejected, 0 not found, 15,995 duplicate, and 620,014 checks in 30 days. The 2026-09-30 bar summed to 52,889, matching Checks Today 52,889. These are exact matches at this reload; all recorded checks are within this seven-day window, so the 30-day and all-status totals are valid cross-checks for its overall and status sums.
- The history counters use `GET /v1/admin/verifications` with their own `CountAll` query; the chart uses `GET /v1/admin/verifications/daily` and `AdminDailyCounts`. This verifies the aggregate totals through two production query paths. It does not independently reconcile each historical day's bucket against direct database SQL. The `vestearth` AWS profile was verified as account `122991883560` / user `vestearth`, but `rds:DescribeDBInstances` is denied, so no direct production RDS query was run.

## Knowledge closeout
- With operator authorization, updated the existing `knowledge-base/Knowledge Base/10 Projects/VerifySlip/Slip Time Zone And Admin Latency Fixes — 2026-09-28.md` to mark the 100-row chart as historical and record the TASK-VS-014 production behavior, the 11:06 ICT aggregate cross-check, and its limits. `git diff --check` passed. The vault checker reported only pre-existing warnings in unrelated notes (stale GitOps dates, two source warnings, two orphans); it reported no issue for this note.

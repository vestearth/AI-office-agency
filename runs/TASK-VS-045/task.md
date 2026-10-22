# TASK-VS-045: Instrument admin verification COUNT paths

SPAR-37: Add selective slow/error logging for COUNT paths of GET /v1/admin/verifications and /v1/admin/verifications/status-counts in slip-api. Log path, cache fallback reason, filter key names only, date span, each COUNT duration, and request_id. No filter values or PII. Preserve count logic, timeout, API contract and response. Unit tests cover logging branches; go test ./... passes. Open PR into main only; do not merge or deploy.

## 2026-10-22 implementation handoff

- Branch `task/TASK-VS-045-admin-count-logging`, commit `b482577`; [slip-api PR #84](https://github.com/SparqLab/slip-api/pull/84) is open into `main` for review. No merge or deploy.
- Counts and grouped status counts emit structured path/reason, filter key names, date span, duration and request ID only after an error or a 1-second threshold. No filter values or raw error text are added to the logs.
- Verification: `go test ./...`, `GOWORK=off go build -mod=readonly ./...`, `go vet ./...`, focused race tests, and `git diff --check` passed on the branch.
- Production filter, query plan, and DB wait cause remain unknown. This PR only adds evidence for a future occurrence; it does not change count logic, timeout, migration, or API contract.

## 2026-10-22 main merge

- Earth approved merging PR #84 into `main` without the nonblocking lock logging adjustment. Before merge, the two workflows on `origin/main` were checked: deploys trigger only from pushes to `staging` and `prod`, respectively, or manual dispatch.
- PR #84 merged with the repo's prior merge-commit method. `gh pr view 84 --json mergeCommit,state` returned `MERGED` at `eb01ae8d0be7e7f36ac63a7a22fe188730237a2d`.
- No staging or prod merge and no deployment were performed. Earth retains that decision.

# TASK-EAR-418: Order: PR vet workflow (incl. -tags integration) + UpdatePaymentState gateway integration test

Follow-up to TASK-EAR-403. Operator asked (2026-10-28) for this run to be implemented in the Claude lane. That overrides the open-only default for this run only.

## Why

TASK-EAR-352 (f5806e5) added a `paymentGateway` argument to `UpdatePaymentState`.
`tests/integration/purchase_test.go` was not updated, so the `integration`-tagged
package stopped compiling. Nobody saw it until TASK-EAR-403 (#81, staging only),
because no Order workflow builds tagged files. The only workflows are the
push-to-deploy ones. The gateway stamp SQL also had no real-database test.

## Scope

- Games-Labs-Order `.github/workflows/vet.yml`, triggered on `pull_request`:
  - runs `go vet ./...` and `go vet -tags integration ./...`
  - reads `contents` only
  - fetches `shared-lib` with the repo secret `GH_PAT` through `~/.netrc`, like the Dockerfile
- `tests/integration/purchase_test.go` gets `TestUpdatePaymentStateStampsPaymentGateway`:
  - a captured gateway is stamped and stored
  - a replay on a settled order cannot restamp it
  - an empty gateway keeps the stored one

## Acceptance

- Each rule in the new test fails on a mutated query and passes on the real SQL.
- Vet passes for both tag sets.
- The full integration suite is green on an empty postgres:16-alpine.
- The Vet workflow runs and passes on the PR to staging.

## Out of scope / notes

- Prod still fails `go vet -tags integration` (aedf982). The TASK-EAR-403 fix reaches prod only through release PR #83 (TASK-EAR-402 train).
- The new workflow is not a required check. Merge to staging/prod is still the deploy.
- No other Games-Labs service has a PR vet/test workflow. Tag-gated packages elsewhere can rot the same way.
- Pre-existing and unrelated: `internal/models/tags.go` is not gofmt-clean on staging.

## Delivery

- Branch `task/TASK-EAR-418-pr-vet-workflow`, commits 3662bcb (test) and db93108 (ci)
- PR https://github.com/SparqLab/Games-Labs-Order/pull/86 targets `staging`

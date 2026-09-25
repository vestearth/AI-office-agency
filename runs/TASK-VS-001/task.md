# TASK-VS-001 — Repair slip-api production line source migration

## Origin and evidence

On 2026-09-23, production deploy `slip-api-production:23` (`2de8a6c`)
failed during goose migration `037_line_source_oa.sql`. CloudWatch logged
`SQLSTATE 23514` when its `UPDATE` changed `line_source='user'` to `oa`
before replacing `verifications_line_source_check`. ECS stopped the new tasks
with exit code 1. The service was restored to task definition `:22`.

Staging reported goose version 37 at 14:56 UTC and is running the new image.
Thus migration 037 has been applied in at least one environment. The workspace
schema rule prohibits editing an applied migration. On 2026-09-23 the operator
explicitly authorized an exception to amend 037, with recorded justification
and tests for staging and production. Migration 038 is required to bring staging,
where the original 037 is already marked applied, to the widened constraint.

## Scope

- Owner: `slip-api`; code branch `task/TASK-VS-001-line-source-migration`.
- Repair the production migration path without losing existing `user` values.
- Keep both old `:22` writers (`user`) and new writers (`oa`) accepted through
  rolling deployment and the rollback window.
- Update `slip-api/.github/workflows/deploy-production.yml` to change the task
  definition without overriding the service's existing desired task count.
- Add a database-backed regression check that fails on the original sequence
  and passes on the chosen repair; verify migration Up and rollback behavior.
- Run focused tests, build, and migration checks; record actual evidence.
- Prepare a deployment and rollback handoff, with production DB state and
  authenticated acceptance explicitly gated by runtime checks.

## Out of scope

- No edits to other VerifySlip repositories, public API contracts, or frontend.
- No direct production DDL, destructive data rewrite, or production promotion
  without a reviewed migration route and verification.

## Acceptance

1. A database with legacy `line_source='user'` passes the repair path and
   retains those records as `oa` after backfill.
2. Both `user` and `oa` remain valid during mixed-version rollout/rollback.
3. The original migration failure is reproduced before the fix and the same
   case passes after; other allowed values remain valid.
4. Task state, verification evidence, deployment order, and remaining runtime
   gates match what was actually performed.
5. The production deploy workflow does not reset the live ECS desired count.

## Migration plan

- Production: amended 037 first widens `verifications_line_source_check` to
  permit both `user` and `oa`, then backfills `user` to `oa`; 038 repeats the
  compatible constraint so both environments converge.
- Staging: already-applied 037 is not replayed; 038 widens its oa-only check.
- The 037 Down backfills `oa` to `user` while retaining the wider constraint.
  The 038 Down is intentionally forward-only so a rollback cannot narrow the
  constraint beneath older writers.
- Do not contract away `user` until old-image rollback is retired and existing
  writes have been rechecked.

## Local implementation checkpoint — 2026-09-23

- `slip-api/migrations/037_line_source_oa.sql`: widen the check to accept
  `user` and `oa` before converting legacy rows; Down restores data to `user`
  while retaining dual-value compatibility. This amends an already-applied
  migration under the operator's explicit exception above.
- `slip-api/migrations/038_line_source_compatibility.sql`: converge staging's
  already-applied original 037 to the dual-value check; Down intentionally
  leaves the expanded check in place.
- `slip-api/migrations/run_test.go`: database-backed regression for both
  starting states, accepted old/new writers, rejection of invalid values,
  and migration Down. The existing file-count expectation was stale at 35
  before this task; it now reflects all 38 migration files.
- Change committed as `059ac79` and pushed on
  `task/TASK-VS-001-line-source-migration`.
- PR #3 targeting `staging` merged at `32decd1` on 2026-09-23.
- Per operator direction to use the `main → staging → prod` branch flow, PR #4
  (`staging` → `main`) merged at `b7b32d4` on 2026-09-23; it contains only
  the already-reviewed migration fix. `origin/main` and `origin/staging` now
  have identical trees (`ev-018`).
- Merging PR #4 did not deploy: the repository workflows trigger from
  `staging` and `prod`, not `main`. Production remains untouched.
- PR #5 (`main` → `prod`) was closed as the wrong promotion source. PR #6
  (`staging` → `prod`) is open and intentionally unmerged while production
  readiness gates are pending. It contains migrations 037/038, the regression
  test, and the production desired-count workflow fix. PR #6 is mergeable and
  shows successful staging build/deploy checks (`ev-027`, `ev-029`). Its body
  records current verification and the remaining production database gate.
- Production readiness snapshot at 2026-09-23 16:42 UTC: service desired/running
  `3/3`, pending `0`, task definition `slip-api-production:22`, rollout
  `COMPLETED`; all three ECS API containers report `RUNNING/HEALTHY`, and the
  unhealthy-host alarm is `OK` (`ev-020`, `ev-023`, `ev-024`). Latest available production
  goose log reports version 36 at 15:37:58 UTC (`ev-021`), below migration 037.
  Direct RDS describe access is denied, so this version is log-derived rather
  than a live database query. A simulated merge of `origin/main` into
  `origin/prod` changes only 037, 038, and the migration regression test; the
  prod-only ECS task-definition JSON is preserved (`ev-022`, `ev-025`).
- `Deploy STAGING` run `35887974607` completed successfully; ECS rollout state
  is `COMPLETED`.
- ECS staging first ran task definition `slip-api-staging:61` (image from merge
  commit `32decd1`). After the desired-count workflow change was promoted
  through main → staging, Deploy STAGING run `35902023654` completed
  successfully and staging now runs `slip-api-staging:62`, desired/running
  `1/1`, pending `0`, rollout `COMPLETED`; the new task is `RUNNING/HEALTHY`
  (`ev-029` to `ev-031`).
- The latest staging startup log reports goose version 38, and
  `https://api-staging.up-slip.com/health` returned HTTP 200 (`ev-032`,
  `ev-033`). The earlier `:61` image tag is recorded in `ev-017`.
- CloudWatch log from task `4111965374d44d10b7b20598c81a80ee` confirms
  `goose: successfully migrated database to version: 38` (`ev-012`). Public
  staging `/health` returned HTTP 200 (`ev-009`).
- ALB `HealthyHostCount` minimum stayed at 1 throughout the observed rollout
  window (`ev-014`).
- Direct ALB `DescribeTargetHealth` is not allowed for the current AWS identity;
  ECS task health and the public health endpoint are verified instead.
- Production was rechecked after the staging release: it remains on task
  definition `slip-api-production:22`, desired/running `3/3`, pending `0`,
  rollout `COMPLETED` (`ev-034`). No goose startup log appeared in the recent
  query window (`ev-035`); the latest observed production version remains the
  older log-derived version 36 (`ev-021`), not a direct DB query.
- No production deployment or production database action has occurred.

Verification from the AI Dev Office evidence ledger:

- `ev-001`: original 037 failed in disposable PostgreSQL on a legacy `user`
  row with `SQLSTATE 23514`, matching the production error.
- `ev-002`, `ev-003`: focused regression passed after the repair, including
  both production and already-applied staging starting states.
- `ev-004`: first full suite failed only because the old migration file-count
  assertion was stale; this was corrected without dropping its checks.
- `ev-005`: `go build ./...` passed.
- `ev-008`: `go test ./...` passed with the PostgreSQL regression enabled.
- `ev-009` to `ev-017`: staging health, ECS task health and rollout, goose
  version 38, ALB healthy-host metric, merged PR, and successful workflow run.
- `ev-028`: production workflow passes actionlint/YAML/diff checks and no
  longer supplies `--desired-count`.
- `ev-029` to `ev-033`: successful staging deploy `:62`, healthy ECS task,
  goose version 38, and HTTP 200 health endpoint after main → staging.
- `ev-034`, `ev-035`: production remains `:22` at desired/running `3/3`; the
  recent log query did not show a new goose version.
- `git diff --check` and `ruby ai-dev-office/validate-yaml.rb TASK-VS-001`
  passed locally.

## Release handoff and gates

1. **Complete:** diff reviewed; PR #3 merged into staging; local regression,
   build, goose version 38, ECS health, ALB metric, public health, and deploy
   workflow all verified.
2. Authenticated LINE verification was not exercised on staging and is
   explicitly deferred by the operator for this migration-only promotion.
3. Before promotion, recheck the production database migration version and
   constraint using approved DB access; the current goose version 36 is based
   on the latest available log, not a direct query. Confirm it is still below
   37 and review row volume/expected DDL lock duration for the 037 constraint
   change and backfill.
4. The production workflow fix is complete: task-definition registration no
   longer sends a desired-count value, so the service keeps its existing
   desired count (currently 3) during this update (`ev-028`).
5. Use PR #6 to promote the deployed/tested `staging` source to `prod`. Merging
   it pushes `prod` and automatically starts Deploy PRODUCTION; verify 037 then
   038, ECS stable health, ALB healthy hosts, and `/health`. Authenticated LINE
   smoke is deferred by explicit operator direction and is not a gate for this
   migration-only release.
6. Roll back the image to `:22` if needed. The expanded DB constraint is kept
   deliberately, so the old image can still write `user`; do not reverse 038
   or narrow the constraint during the rollback window.

## Closeout update — 2026-09-25

The release gates above describe the 2026-09-23 handoff. PR #6 subsequently
merged to `prod` at `d5996c8`; Deploy PRODUCTION run `35946617255` succeeded.
Production CloudWatch recorded migration to goose version 38 on 2026-09-24,
and the current `slip-api-production` service is 3/3 with rollout `COMPLETED`.
The production constraint was not queried directly, and authenticated LINE
verification remained an explicitly deferred business check.

The current tree contains a later migration 039. Its `TestGooseSQLFiles` count
still expects 38 and fails today; this later test regression does not change
the observed production migration result. Current PostgreSQL regression tests
were skipped because `SLIP_API_MIGRATION_TEST_DSN` was unset.

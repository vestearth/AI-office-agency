# TASK-VS-015 — Set POSTGRES_MAX_CONNS=80 on slip-api production

## Problem
Live prod task definition `slip-api-production:57` sets no `POSTGRES_MAX_CONNS`, so each of the 3 tasks uses the code default of 100 (300 total). Operator asked for 80 per task (240 total) on prod only; staging unaffected.

## Scope
- `slip-api/.github/workflows/deploy-production.yml`: inject `POSTGRES_MAX_CONNS: "80"` (string) into the container env. `deploy.yml` (staging) untouched.
- No scaling, no RDS change. Takes effect on the next `Deploy PRODUCTION` run (push to `prod` or workflow_dispatch).

## Rollback
Revert the one-line change and redeploy (default returns to 100), or re-register the task definition with the env var removed.

## Delivery verification (2026-09-30)
- [PR #43](https://github.com/SparqLab/slip-api/pull/43) merged into `prod` at 08:46:38Z as `6dbcf1d`.
- [Deploy PRODUCTION run 36691833314](https://github.com/SparqLab/slip-api/actions/runs/36691833314) succeeded for that commit.
- ECS `slip-api-production` has primary task definition `:58`, rollout `COMPLETED`, desired/running `3/3`, pending `0`. Its `slip-api` container has `POSTGRES_MAX_CONNS=80` and image `production-sha-6dbcf1d`.
- This verifies the deployed configuration and rollout; database connection counts and application-level load behavior were not measured.

## Outcome (verified 2026-10-01)
- PR SparqLab/slip-api#43 merged into `prod` at 2026-09-30T08:46:38Z (6dbcf1d). Deploy PRODUCTION run 36691833314 succeeded.
- Live `slip-api-production:58` carries `POSTGRES_MAX_CONNS=80`; desired/running 3/3. Prod went from 100/task (300 across 3 tasks) to 80/task (240); max autoscale 10 tasks = 800.
- Not checked: DB-side or application-level load acceptance after the rollout.

## Capacity assessment for 6 customers (operator question, 2026-09-30)
Basis: CloudWatch prod 7 days, `origin/prod` code, `jaview/Knowledge Base/Work Log Sep 2026/10 Upslip Scale-up Plan.md`. Assumes linear load growth and all customers peaking together (worst case).
- Today (1 customer): ~10.5k ALB req/h at peak, max 463 req/min; slip-api hourly-average CPU ~12-13% on 3 tasks; RDS conns ~70 normal, 7-day max 238; RDS moved to m6g.large 2026-09-30 04:00 (free memory ~1.7 -> ~4.5 GB, swap 0). Only slip-api connects to Postgres (slip-system uses Redis).
- ECS min 3 / max 10: no change needed. ~75% CPU on 3 tasks triggers autoscale to ~4-5 tasks. Do not raise max (each task adds a pool). Raising min to 4 is optional to cover scale-out lag.
- RDS m6g.large: no change needed for RAM or connections; CPU is the watch item (~12% x 6 ~ 70% on 2 vCPU). Move to m6g.xlarge if peak-hour average CPU stays above ~60%.
- `POSTGRES_MAX_CONNS`: 80 keeps 10 tasks (800) under the ~860 ceiling estimated for m6g.large (computed from RAM; `rds:Describe*` is denied for profile `vestearth`, so not read from the parameter group). Do not go below ~80 yet: `AcquireIdempotencyLock` (`slip-api/internal/repositories/verification.go:129`) holds a connection across the bank call, so one verify uses two connections and a small pool would starve.
- Real bottleneck is bank/slip-system budget, not ECS or RDS: 6 customers ~1,000 req/min vs the 1,100/min proven in the 2026-09-24 load test.

## Follow-ups (not part of this task)
1. Rework the idempotency lock so it does not hold a DB connection during the bank call, then lower the pool to 20-30/task.
2. Add an RDS CPU alarm (peak-hour average > 60%) alongside the memory, swap and connection alarms.
3. Confirm per-minute bank budget with the team for 6 customers.

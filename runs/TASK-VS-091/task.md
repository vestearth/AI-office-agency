# TASK-VS-091: SPAR-78: promote slip-api LINE bank logo startup fix to production

Promote slip-api staging adb89e9 (single commit 857068d, fix for the 0f61bcb route panic) to prod through a release PR. Prod runs td 161 while td 162 loops on the panic. No migrations. Earth approved opening the PR on 2026-11-19; merging needs a separate go-ahead.

## Result (2026-11-19)

Earth approved opening the prod PR, then merging it, both in chat. PR [#167](https://github.com/SparqLab/slip-api/pull/167) (`release/TASK-VS-091-production` → `prod`) merged pinned to head `34a7d66` as merge commit `682216b`. The merged `origin/prod` tree is `38de8e1`, identical to the dry-run tree and to the staging tree. Scope was one commit, `857068d` (PR #165 via #166). No migrations. `0f61bcb`, `857068d`, `66effb2` and `adb89e9` are all ancestors of `origin/prod`.

- **Before:** prod served `slip-api-production:161` (`production-sha-e6d0e74`, 3/3). Deploy `:162` (`production-sha-1b61947`) panicked on every start with `bad wildcard segment` for the route `GET /v1/line/banks/{code}.png` and ECS had replaced 15 tasks. Prod has no deployment circuit breaker.
- **After:** `slip-api-production:163` (`production-sha-682216b`) is PRIMARY and `COMPLETED`, running = desired, `failedTasks` 0, all targets healthy. Env and secret hashes of `:161` and `:163` are identical, so only the image changed. Rollback revision was `:161`.
- **Window 09:47–10:03Z:** 4,607 requests, 5xx 0, panic 0, `ERROR` 0. Statuses: 200 ×4,429, 422 ×111, 409 ×50, 400 ×14, 404 ×3. Real requests to `/v1/line/banks/scb.png` and `ktb.png` returned 200 on the new tasks. Evidence `ev-001`. The check script ran later (13:22Z), so its ECS section shows 5/5 tasks (Auto Scaling) rather than 3/3.
- **Deploy PRODUCTION run 44499504721** ended red on `Waiter ServicesStable failed: Max attempts exceeded` (09:48:51Z → 09:59:24Z). ECS finished the rollout after that. The same waiter timeout hit staging for this fix (staging took 13.5 min to settle).

### Not covered

- Behavior after about 16 minutes past the deploy; no `check_after` was set.
- `ev-001` records `repo_sha` of the local `slip-api` checkout (a stale local `staging`), not the promoted commit; the promoted commit is in the log (`origin/prod` = `682216b`).
- Public HTTP from outside the VPC was not probed; the bank-logo evidence is the service's own request log.

### Follow-ups, none started, none approved

1. Make the deploy workflows wait longer than `aws ecs wait services-stable` (~10 min), or judge the rollout from `describe-services`.
2. Turn on the deployment circuit breaker with rollback for `slip-api-production` (prod config change).
3. Run `go test` in CI before a deploy. `0f61bcb` broke the existing router tests, but no workflow runs them.

# TASK-VS-002 — Shared KBank verification attempt budget

## Origin

The operator requested implementation after confirming the bank permits 1,200
transactions per minute. Production slip-system has multiple replicas. Its
existing process-local limiter admits a verification once before retries, so
the number of outbound verification attempts can exceed the bank budget.

## Scope

- `slip-system`: enforce one Redis-backed budget across live KBank replicas.
  Charge every outbound verification HTTP attempt, including network/5xx
  retries and the attempt after a 401 token refresh. Keep test/mock traffic
  out of the live budget, preserve provider error mapping and local bulkhead.
- `slip-api`: preserve queue backpressure when the shared bank budget is full;
  avoid repeatedly reclaiming busy jobs at a fixed short interval if a
  bounded, compatible change is needed.
- Configure a conservative, adjustable starting limit below 1,200 per rolling
  60 seconds. Make Redis failure stop bank attempts rather than silently fall
  back to a per-process limit.

## Out of scope

- No public/protobuf contract change, migration, frontend edit, live bank load
  test, production deployment, or change to merchant billing/duplicate rules.
- Bank contract details about window alignment, burst policy, and whether OAuth
  calls count still require confirmation before production tuning.

## Acceptance

1. Concurrent replicas sharing Redis cannot obtain more permits than the
   configured budget in a rolling 60-second window.
2. Each outbound live verification attempt consumes one permit, including
   retry and post-401 attempts; rejected permits cause no bank HTTP request.
3. Redis failure does not permit bank verification; mock/test paths continue
   to work without consuming the live budget.
4. Queue workers treat budget exhaustion as temporary backpressure, while
   synchronous callers retain an explicit rate-limit response.
5. Focused tests plus repository-wide Go tests/build pass, or failures are
   documented with exact scope. Production capacity acceptance remains a
   separate staging/load/runtime gate.

## Local implementation checkpoint — 2026-09-24

- `slip-system` reserves each live KBank verification HTTP attempt through one
  Redis sorted-set rolling window, shared by replicas using the same Redis and
  bank base URL. The local rate limit and bulkhead remain safety controls.
  The default shared cap is 1,000 attempts per 60 seconds; configuration above
  the bank-confirmed 1,200/minute ceiling is rejected.
- The reservation occurs inside the retry loop, after OAuth preparation and
  immediately before the verification HTTP request. It therefore covers 5xx,
  network/read retries, and post-401 re-entry. Missing Redis prevents live
  startup; Redis failures during requests prevent verification HTTP calls.
- gRPC now carries RetryInfo on rate-limit responses. `slip-api` returns
  Retry-After for synchronous callers and delays queue requeue by that value.
  No protobuf or public response-body contract changed.
- Verified with task evidence: slip-api full Go test `ev-001`, slip-system full
  Go test `ev-008`, slip-api build `ev-003`, Redis-backed race/integration test
  `ev-011`, slip-system build `ev-010`. `git diff --check` and task YAML
  validation also passed. The full Go tests and builds passed again after
  rebasing both branches onto current `origin/staging`.

## Pull requests

- `slip-api`: commit `ed2415c`, [PR #9](https://github.com/SparqLab/slip-api/pull/9) merged into `staging`; [PR #10](https://github.com/SparqLab/slip-api/pull/10) merged `staging` into `main` to reconcile this earlier branch order. [PR #11](https://github.com/SparqLab/slip-api/pull/11) is open from `staging` into `prod` for the four TASK-VS-002 files. A merge-tree simulation preserves the prod-only ECS task definition and workflow.
- `slip-system`: commit `12ee5bb`, [PR #1](https://github.com/SparqLab/slip-system/pull/1) merged into `staging`; current `main` and `staging` point to the same commit, and the feature commit is an ancestor of `prod`.
- From the next VerifySlip task onward, start from `main`, PR into `main`,
  promote `main` to `staging` by PR, then promote tested `staging` to `prod`
  by a separate PR. This one-time `staging` to `main` PR closes the branch gap.
- Git refs and PR states were verified on 2026-09-24. Deploy STAGING build and
  deploy jobs for slip-api staging head `92591b9` succeeded; staging traffic,
  load, and production runtime acceptance remain unaudited in this task.

## Review and rollout gates

- Review the two PRs together. Roll out `slip-api` first so queue
  workers understand RetryInfo, then `slip-system`; mixed old/new system tasks
  cannot provide a strict shared cap while old tasks still call the bank.
- Confirm the bank's exact accounting scope (rolling/fixed window, burst,
  OAuth inclusion) and Redis Lua/ACL and eviction behavior before production.
- Run a staging test with distinct slips and a mocked or approved bank budget;
  compare actual verification attempts with the cap, queue delay, latency, and
  429/5xx/504 outcomes. No production deployment or live-bank load test was run.

## Closeout update — 2026-09-25

The handoff above records the original pre-release gates. `slip-api` PR #11
and `slip-system` PR #4 subsequently merged to `prod`, and their production
deploy workflows succeeded. Current ECS services are each 3/3 with completed
rollouts. `slip-system-production:20` sets the shared attempt budget to
1,200/min. TASK-VS-003 production ladders observed bank responses through
1,100/min with zero 5xx; at 1,200/min the shared rolling budget shed 77
requests as 429. This is runtime evidence of budget behavior, not a separate
vendor confirmation of OAuth/window accounting or merchant fairness.

# TASK-VS-016 — Release PostgreSQL connections during idempotent bank waits

## Context

TASK-VS-015 set `POSTGRES_MAX_CONNS=80` per production task and identified that
`AcquireIdempotencyLock` holds a PostgreSQL session advisory lock, and therefore
a pool connection, across the slip-system/bank request. The recorded follow-up
is to remove this connection pressure before considering a lower pool cap.

## Goal

Keep same-key verification requests serialized across API instances while
returning the PostgreSQL pool connection during the external bank wait. Preserve
existing replay, request-hash conflict, cancellation, and NOT_FOUND retry behavior.

## Scope

- `slip-api/internal/repositories/verification.go`: replace connection-pinned
  locking with a database-backed lock whose database operations use short-lived
  pool checkouts.
- `slip-api/internal/core/service/verification.go` and repository ports/adapters:
  propagate lock ownership loss/cancellation safely.
- Add a migration for lock storage and update migration inventory coverage.
- Repair the independently merged `migrations/054_package_stop_email_alerts.sql`
  Goose statement delimiter only if its failure blocks migrations required by
  the two-phase rollout; keep its business SQL unchanged.
- Add service concurrency coverage and PostgreSQL-backed serialization and pool
  connection measurements.
- Do not change production runtime, deployment settings, or `POSTGRES_MAX_CONNS`.

## Acceptance Criteria

- Concurrent requests using the same branch and idempotency key cannot call the
  bank concurrently; a persisted result is replayed and a different request hash
  still returns the existing conflict.
- Existing NOT_FOUND cooldown and same-key retry behavior remains covered.
- While distinct idempotency locks are held during a simulated bank wait, the
  PostgreSQL pool reports no connection retained by those locks; same-key lock
  acquisition remains serialized in real PostgreSQL.
- Focused Go tests and the relevant build checks pass. Record measured acquired
  connections and test concurrency in this task.
- No recommendation to lower the production pool below 80 per task without
  representative runtime connection measurements after deployment.

## Rolling Compatibility Plan (operator choice, 2026-10-05)

Production currently runs three old session-lock tasks, and its rolling
deployment overlaps old and new binaries. Use two releases without an outage:

1. Deploy a dual-lock version that holds the old advisory lock and a new lease
   row. It serializes with old tasks and seeds the new lock protocol, but still
   holds one connection during a bank wait.
2. After all production tasks run the dual-lock version, deploy the final
   lease-only version. Old dual-lock tasks and new lease-only tasks serialize
   through the lease row; once all tasks are lease-only, bank waits release
   their pool connections.

The user selected this route over a brief all-new-task cutover. A concurrent
`slip-api` commit took migration version 054 and introduced a Goose parse error
in that migration. The lock migration must be renumbered to 055, and the
preexisting 054 parser issue must be fixed before the dual-lock rollout.

## Implementation and Verification (2026-10-05)

- Replaced the session advisory lock with a PostgreSQL lease row keyed by
  `(branch_id, idempotency_key)`. Acquisition, renewal, and release use short
  pool checkouts; a 30-second lease is renewed every 10 seconds. Lost ownership
  cancels the service context. Both `Verify` and `VerifyBank` use that context.
- Added migration `055_verification_idempotency_locks.sql`. No HTTP/protobuf
  contract, deploy setting, or pool limit changed.
- Before the fix, the PostgreSQL-backed bank-wait test measured 3 acquired
  connections for 3 simultaneous keys (`max=10`). A 12-key attempt also reached
  the 10-second context limit while waiting for pool checkouts.
- After the fix, the same 3 simultaneous active lock scopes measured
  `acquired=0`, `total=3`, `max=10`. PostgreSQL same-key acquisition remained
  serialized. The service concurrency test persisted/charged once and called
  the fake bank once; a changed request hash still returns the conflict.
- `go test ./... -count=1` passed with disposable PostgreSQL 16 repository and
  migration databases. `go build ./...`, `go vet ./...`, and targeted
  `go test -race` concurrency checks passed. The race linker emitted a macOS
  `LC_DYSYMTAB` warning but returned exit code 0.
- These are local synthetic measurements, not production pool utilization.
  Keep `POSTGRES_MAX_CONNS=80` per task pending representative runtime metrics.
  Production was not changed. A read-only ECS check on 2026-10-05 found
  `slip-api-production:66` running 3 of 3 tasks with a pool cap of 80 each.
  Its rolling deployment has minimum healthy 100% and maximum 200%, so a
  normal deployment can overlap old session-lock and new lease-lock binaries.
  Those protocols do not coordinate with each other; the production cutover
  needs either a two-phase compatibility rollout or a brief all-new-task
  cutover before this PR is promoted to `prod`.

## Notes

- Parent context: `ai-dev-office/runs/TASK-VS-015/task.md`.
- The attached 2026-10-05 log screenshot shows retries without an explicit
  `Idempotency-Key`; that existing request behavior is outside this change.
- Commit `4e820d1` was pushed and implementation PR
  [slip-api #48](https://github.com/SparqLab/slip-api/pull/48) targets `main`.
  That initial single-step PR had no repository CI check attached and was
  later closed when the two-phase rollout replaced it.
- The committed SHA was rechecked with `go test ./... -count=1` against two
  disposable PostgreSQL 16 databases on 2026-10-05. The focused lock test
  again measured `acquired=0 total=3 max=10` for three active distinct keys;
  same-key serialization passed. The disposable database was stopped and
  removed after the check.

## Two-phase release evidence (2026-10-05)

- A concurrent email-alert commit consumed migration number 054 and its
  `DO $$` block failed Goose parsing. The two-line delimiter fix passed
  PostgreSQL 16 migration/repository tests and merged in
  [PR #51](https://github.com/SparqLab/slip-api/pull/51), then staging
  [PR #52](https://github.com/SparqLab/slip-api/pull/52). Staging logs showed
  migration 054 applied at 14:09 Thai time. The lock table is migration 055.
- Phase 1 dual lock merged to `main` in
  [PR #53](https://github.com/SparqLab/slip-api/pull/53), then to `staging`
  in [PR #54](https://github.com/SparqLab/slip-api/pull/54). Fresh PostgreSQL
  16 full Go suite, build, vet, and focused race test passed. A real mixed
  old/dual test showed mutual exclusion, and three simultaneous distinct keys
  measured `acquired=3 total=3 max=10` as expected while the compatibility
  advisory lock is still held. Staging task definition 109 completed rollout
  with 1/1 running and migration 055 applied; `/ready` returned 200.
- Phase 2 lease-only code merged to `main` in
  [PR #55](https://github.com/SparqLab/slip-api/pull/55) and to `staging`
  in [PR #57](https://github.com/SparqLab/slip-api/pull/57). Fresh PostgreSQL
  16 full Go suite, build, and vet passed. Three simultaneous distinct keys
  measured `acquired=0 total=3 max=10`; same-key serialization passed. The
  phase 2 staging workflow passed; staging task definition 110 reached 1/1,
  rollout COMPLETED, and /ready returned 200.
- The original single-step [PR #48](https://github.com/SparqLab/slip-api/pull/48)
  was closed as superseded. Phase 1 production promotion
  [PR #56](https://github.com/SparqLab/slip-api/pull/56) has completed; see
  the authorized two-phase rollout update below. The pool cap remains
  80/task.

## Authorized two-phase rollout update (2026-10-05)

The operator explicitly selected a no-outage two-phase production rollout.
Phase 1 is deployed from [PR #56](https://github.com/SparqLab/slip-api/pull/56),
merged to `prod` at `316cb5e`. Production ECS revision `:69` runs 3/3 tasks,
with the previous `:68` drained; the image is
`production-sha-316cb5e`, `POSTGRES_MAX_CONNS=80`, migration 055 is applied,
and `/ready` returned 200. GitHub deployment workflow 37278968175 succeeded
and ECS rollout reached `COMPLETED`.

Staging phase 2 PR #57 is merged and its deployment workflow 37277804744
passed. Staging ECS revision `:110` reached 1/1 with rollout `COMPLETED`,
revision `:109` drained, and `/ready` returned 200.

The phase 2 production promotion [PR #58](https://github.com/SparqLab/slip-api/pull/58)
was merged to `prod` at `3e34785`. Workflow 37280034578 succeeded. Production
ECS revision `:70` runs 3/3 healthy tasks with rollout `COMPLETED`, the
previous `:69` is drained, and `/ready` returns 200. The image is
`production-sha-3e34785`; `POSTGRES_MAX_CONNS=80` remains configured.

After phase 2, twelve public `/metrics` scrapes over about one minute returned
`acquired_connections=0` each time and `total_connections=21-22`. These
load-balanced samples are a short current-traffic snapshot, not per-task peak
utilization. Keep the 80/task cap; this sample does not justify reducing it.
The separate TASK-VS-017 frontend production PR #8 merged at
`5900de3` and its ECS deploy is underway.

AWS CLI identity was checked as account `122991883560`, IAM user `vestearth`.
Production logs identify the missing-key requests as Node traffic for one
branch and one client IP. That IP did not match this account's Elastic IPs,
network interfaces, or NAT gateway addresses, so AWS resources in this account
do not identify the caller repository. Current production pool metrics returned
`acquired=0`, `total=23` in a single scrape; this is not representative enough
to recommend reducing the 80-connection per-task cap.

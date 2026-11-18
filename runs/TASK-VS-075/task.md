# TASK-VS-075: slip-api email alerts: claim query times out on quota_history scan (no alert emails since 2026-11-17 09:17Z)

Opened 2026-11-18 by the Claude conductor on Earth's instruction ("ทำ F1 เลย เปิด TASK-VS
แล้วแก้พร้อม regression test"). Read-only investigation done first in a side session;
evidence summary below.

## Symptom

Since 2026-11-17 09:17:49Z, `/ecs/slip-api-production` logs
`process email alerts` / `iterate email alerts: timeout: context deadline exceeded`
on every run of every task (one run per task per minute; 180/h with 3 tasks, 300/h
with 5). Still failing at 2026-11-18 02:50Z. `RunOnce` returns on the claim error
before any `Send`, so **no quota/expiry/renewal alert email of any type has been sent
since the onset**.

## Root cause (inference from code + logs + RDS metrics; no DB access for EXPLAIN)

- `ClaimDueAlerts` (`internal/repositories/email_alert.go`) runs BEGIN + enqueue
  INSERT…SELECT + claim SELECT + per-row UPDATE + COMMIT under one 3 s context
  (`cmd/main.go` `queryTimeout`).
- The claim SELECT has `LEFT JOIN LATERAL (SELECT MAX(qh.created_at) FROM quota_history qh
  WHERE qh.branch_package_id = bp.id AND qh.created_at >= bp.starts_at) stopped`
  (added in `4921872`, 2026-10-05). `quota_history` has no index leading with
  `branch_package_id` (migration 021: `branch_id`, `merchant_id`, `reference` only), so
  every candidate alert costs a full scan of a table that grows by one row per
  quota-consuming verification.
- When the scan exceeds the budget, the transaction rolls back (including the enqueue),
  so the same alert is due again next minute: self-perpetuating, and one candidate
  blocks the whole batch.
- Earlier episodes with the same signature: 10-18, 10-25, 11-08 (1–2 min, recovered),
  11-11 07:02–09:10Z (128 min). RDS `upslip-postgres-prod` shows a read burst at the
  gp3 throughput cap and CPU +6..+10 points for exactly the failing windows.
- Not deploy-related: the alert code is unchanged since `47d1930` (2026-10-16).

## Scope (F1 — code only, no schema change)

- In the `stopped` LATERAL, add `qh.branch_id = bp.branch_id` so the planner can answer
  the MAX from the existing `quota_history_branch_created_idx (branch_id, created_at DESC,
  id DESC)`. Both quota_history writers take `branch_id` from the package's own branch
  (fast path `UPDATE … RETURNING branch_id`; slow path the branch it looked the package
  up by), and no code updates `branch_packages.branch_id`, so the value is unchanged.
- Compute it only for `d.alert_type = 'quota_exhausted'`, its only consumer
  (`quotaExhaustedMessage`).

Out of scope (follow-ups, not this task): the optional
`quota_history (branch_package_id, created_at DESC)` index (F2, needs a migration and
an off-peak manual pre-build); a separate timeout / per-row isolation for the alert job
(F3).

## Acceptance criteria

1. A regression test against real Postgres fails on current `main`: with sequential
   scans disabled, the claim SELECT's plan still contains a Seq Scan on `quota_history`
   (no usable index path).
2. The same test passes after the fix (index path on `quota_history`).
3. Existing email-alert repository/service tests stay green; `quota_exhausted` alerts
   still carry the last quota_history time of the package as `QuotaStoppedAt`.
4. Full `go test ./...` and `go vet ./...` pass (or failures named, with cause).
5. PR to slip-api `main`; promotion main → staging → prod each through a PR, and each
   promotion step only with Earth's go-ahead.
6. Staging/production acceptance: the `process email alerts` error stops after the
   deploy, CloudWatch read over every page; RDS CPU returns to baseline.

## Rollout notes

- On recovery, every alert that became due since 2026-11-17 09:17Z and still matches its
  guard will be sent in the first runs (up to 100 per run per task) via Gmail SMTP.
- Rollback: revert the PR (query-only change, no migration).

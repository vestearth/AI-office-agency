# TASK-EAR-339 — Prod train close-out: supervised first boot

- Short name: `prod-train-first-boot`
- Type: release / devops
- Workstream: infra
- Priority: critical
- Created: 2026-09-08
- Operator go: 2026-09-09 (Cursor lane)

## Goal

Supervise the first boot of the 2026-09-08 `TASK-EAR-322` prod task definitions
(currently desired 0 / never executed), then close the Auth `GetAccountType`
mixed-version gap before Order comes up.

## Hard order

1. Merge Auth `origin/staging` into `origin/prod` (keep prod-only RDS/DSN/env).
   Deploy PROD, then scale `games-labs-auth-prod` to 1. Watch boot migrations
   (`012_users_account_source`) and confirm `GetAccountType` is reachable.
2. Scale remaining services one at a time, each to a single COMPLETED
   deployment with a task RUNNING before the next: Wallet → Order → Game →
   Missions → User → Provider → Logs → api-gateway.
3. Smoke `api-gateway.gameslabs.app`. Do not flip `VIP_REWARD_CLAIM_ENABLED`.
   Do not create DIAMOND catalog items until Auth is up with Order.

## Rollback

Redeploy the previous task-definition revision for the failing service only
(never `rollout restart`). Auth previous = `:23` until the new Auth deploy
registers `:24+`; then `:23` (prod-sha-c41a3a1) is the Auth rollback.
Wallet before Order if both must go back.

## Out of scope unless the operator widens

- User +4 / gateway +4 (`TASK-EAR-337` / `TASK-EAR-338`, claim switch OFF)
- Provider +16 / Logs +24 beyond confirming what is already on prod

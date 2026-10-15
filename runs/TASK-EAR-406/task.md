# TASK-EAR-406: Backoffice prod release train: promote main to prod

- Type: release / devops
- Workstream: devops (Games-Labs-backoffice)
- Created: 2026-10-15 by the Claude conductor lane at operator request (Readiness
  item 3, option A). Claude opens this run only; nothing is promoted by opening it.
- Gates: preset `train` (`deploy_production`, `production_acceptance`). Carried
  tasks are listed in `status.yaml` `carries` and credited on the Readiness ladder
  through this train's gates (`docs/completion-gates.md`, "Release trains").

## Why

The backoffice reaches prod by merging `main` into the `prod` branch: the
`Deploy PROD` workflow (`.github/workflows/prod.yml` on `prod`) builds a
`prod-sha-*` image, pins it in `k3s-prod/deployment.yaml`, and ArgoCD syncs it
on k3s. It is not an ECS service, so the prod cost gate does not apply to the
deploy itself; accepting it in prod does need the prod gateway and Go services
up.

The last promotion was TASK-EAR-363 (PR #132, `prod` pinned to
`prod-sha-18173c9` on 2026-09-17). That run is `aborted` and has no gates.
TASK-EAR-402 (the Go train) states the backoffice "is not part of this Go train".
So nothing carried the backoffice tasks that passed staging since, and Readiness
showed them stuck at staging.

## State on 2026-10-15

- `origin/prod` = `241bb6e` (pin `prod-sha-18173c9`).
- `origin/main` = `bfc84ac`, 98 non-merge commits ahead of `prod`.

## Carried (gated, staging accepted, commit not in `origin/prod`)

| Task | Staging commit | What |
|---|---|---|
| TASK-EAR-396 | a9f9c72 | Stop offering CATEGORY_TURNOVER / ANY_GAME_TURNOVER on event missions |
| TASK-EAR-397 | 0b81113 | Block saving a SPEND_PROP with no spend target |
| TASK-EAR-398 | 8bcf855 | Empty special item category loads as Randomly by System |
| TASK-EAR-399 | ce55b08 | One constant for the Randomly by System option |
| TASK-EAR-389 | 30820fe (#175) | Monitoring report Promotion tab bound to Order coupon history |
| TASK-EAR-390 | 21c08e1 (#176) | Monitoring report Provider tab bound to Logs provider rounds |

TASK-EAR-389 and TASK-EAR-390 are also carried by TASK-EAR-402 for their Go parts;
their backoffice tabs (#175, #176, both on `main`, not on `prod`, checked
2026-10-15) ship with this train.

Also in `main..prod`, not credited (those runs declare no gates): the monitoring,
player-log and redemption work of TASK-EAR-362..383. Their changes ship with this
train; Readiness cannot credit them.

## Hard order

1. TASK-EAR-402 first (or together): the TASK-EAR-389/390 tabs call Go endpoints that
   exist only in that train. Recorded as `waits_on` (ref TASK-EAR-402).
2. Prepare `release/TASK-EAR-406-backoffice-prod` = `origin/prod` + `origin/main`;
   keep `k3s-prod/` from `prod` (the prod probe hardening from TASK-EAR-363, commit
   4abef95). Open the PR to `prod`; do not merge.
3. Operator authorizes `deploy_production`; merge = Deploy PROD.
4. Verify the run, the `prod-sha-*` pin commit, and the ArgoCD sync (the prod admin
   page's build id changes). A green workflow is built + pinned, not serving.
5. `production_acceptance`: smoke each carried task's behaviour on the prod admin
   host with the prod gateway up; record the host, build id and screenshots.

## Rollback

Revert the pin commit in `k3s-prod/deployment.yaml` on `prod` (ArgoCD syncs the old
image). Never `kubectl rollout restart`.

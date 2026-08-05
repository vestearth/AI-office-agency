# TASK-EAR-214 — Open SG ingress for Games-Labs-Logs port 8088 (blocks TASK-EAR-207/208)

## Type

infra / operator-action

## Priority

high

## Context

TASK-EAR-207 shipped `GET /api/v1/admin/audit-events` (api-gateway -> Games-Labs-Logs,
gRPC on port 8088). Both PRs merged and deployed green to staging (api-gateway
run 31014461917, Games-Labs-Logs run 31012944188). TASK-EAR-208's authenticated
staging smoke (playwright + devtest login) and a direct curl both reproduced the
same failure:

```
HTTP 503 {"code":14,"message":"connection error: ... dial tcp 10.80.140.18:8088: i/o timeout"}
```

`i/o timeout` (not "connection refused") is the signature of a security-group
block, not a crashed/missing service — the ECS deploy itself reported
`wait-for-service-stability: true` as successful, so the task is running and
healthy on its own health check.

## Root cause (found by reading `aws-deploy/ECS/ECS-CLOUD-MAP-STAGING-GUIDE.md` §4)

The shared staging security group `sparqlab-development-ecs-sg`
(`sg-025d7d9f3a3ed2b8a`) documents self-ingress only for **50051–50058**.
Games-Labs-Logs is the **first service ever called by another ECS task** on
port **8088** — every other Logs entry point until now was RabbitMQ consumer
(no inbound TCP needed). No prior task ever needed 8088 open for
inter-service traffic, so nobody added the ingress rule.

(Ports 8083–8087 — the other services' HTTP ports — already work today per
the gateway's existing `GAME_HTTP_URL`/`WALLET_API_URL`/etc, so those must
already have SG rules even though the guide's §4 table only lists
50051–50058; the guide's SG section is likely stale/incomplete rather than
wrong about 8088 specifically being new.)

## What needs to happen (AWS console or IaC, operator only — no code change)

Add an inbound rule to `sg-025d7d9f3a3ed2b8a`:

- Type: Custom TCP
- Port: 8088
- Source: self (`sg-025d7d9f3a3ed2b8a`)

Then re-run the TASK-EAR-208 authenticated smoke (or a plain curl with a
staff bearer against `GET /api/v1/admin/audit-events`) to confirm the 503
clears.

## Out of scope

No code in any repo needs to change — this is exclusively an AWS security
group edit. If `aws-deploy/` is later confirmed to be the actual IaC source
of truth (vs. console-managed), update `ECS-CLOUD-MAP-STAGING-GUIDE.md` §4's
table to include 8088 (and ideally 8083–8087) so this gap doesn't repeat for
the next new service.

## Blocks

- TASK-EAR-208 (PR #76, Games-Labs-backoffice) — cannot demonstrate its live-data
  acceptance criterion until this clears.

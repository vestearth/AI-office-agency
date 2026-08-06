# TASK-EAR-215 — Move Logs gRPC onto the platform's gRPC port range (unblocks TASK-EAR-207/208)

## Type

fix / infra-alignment

## Priority

high

## Context

TASK-EAR-207 shipped `GET /api/v1/admin/audit-events` (api-gateway -> Games-Labs-Logs
over gRPC). Both PRs merged, both deployed green to staging. Every attempt to call
the route returns:

```
HTTP 503 {"code":14,"message":"connection error: ... dial tcp 10.80.140.18:8088: i/o timeout"}
```

reproduced by TASK-EAR-208's authenticated browser smoke AND an independent direct
curl. `i/o timeout` at `dial tcp` = the TCP connect never completed, so this is a
network-reachability problem, not a gRPC/protocol or handler problem (a protocol
mismatch would establish the connection first and fail differently).

TASK-EAR-214 was opened proposing "ask devops to open 8088 in the SG". That would
work, but it treats the symptom. The actual finding:

## Root cause — Logs serves gRPC on an HTTP-range port

Every other service on the platform exposes **two** ports, and the SG's documented
self-ingress range (`50051–50058`, per `aws-deploy/ECS/ECS-CLOUD-MAP-STAGING-GUIDE.md`
§4) is exactly the gRPC range:

| Service | gRPC port (`appProtocol: grpc`) | HTTP port |
|---|---|---|
| auth | 50052 | — |
| provider / order | 50051 | 8080 / 8087 |
| game | 50053 | 8083 |
| wallet | 50054 | 8084 |
| user | 50055 | 8085 |
| missions | 50056 | 8086 |
| **logs** | **none declared** | **8088** (`appProtocol: http`) |

Logs actually speaks **gRPC on 8088** while declaring that port as `http`, and 8088
sits outside the range the SG opens. It is the only service in the platform doing
this — and nobody hit it before because until TASK-EAR-207 no service had ever
called Logs over gRPC (its only inbound path was RabbitMQ consumption, which needs
no listener).

### The code-level bug behind it

`configs/config.go`:

```go
type server struct {
	Port     int64 `envconfig:"PORT" default:"8088"`
	GRPCPort int64 `envconfig:"PORT" default:"50051"`   // <-- tag should be GRPC_PORT
}
```

`GRPCPort` was clearly **designed** to be a separate gRPC port on the platform
convention (its default is 50051), but its envconfig tag says `PORT`, so it always
mirrors `Port`. And `cmd/main.go:96` listens on `Server.Port`, not `Server.GRPCPort`:

```go
addr := fmt.Sprintf(":%d", config.Get().Server.Port)   // 8088 in ECS
```

So the intended design was never actually wired up. Fixing it is what this run does.

## Scope

**Games-Labs-Logs** (PR -> `staging`):

1. `configs/config.go` — fix the tag to `envconfig:"GRPC_PORT"` and set
   `default:"50058"` (50057 and 50058 are the free slots in the range;
   50058 chosen so the trailing 8 mirrors the old 8088 and stays easy to
   remember).
2. `cmd/main.go` — the gRPC listener binds `Server.GRPCPort`, not `Server.Port`.
3. `ecs/task-definition.json` — add the missing gRPC port mapping alongside the
   existing one:
   `{ "name": "grpc", "containerPort": 50058, "protocol": "tcp", "appProtocol": "grpc" }`
   (matching how game/wallet/user/missions declare theirs).
4. **Do NOT add `GRPC_PORT` to `ecs/env.names`** and do NOT touch
   `.github/workflows/*.yml`. Leaving the var unset means envconfig uses the
   `50058` default. Adding it to `env.names` without the workflow exporting it
   would render `""`, which envconfig cannot parse into an int64 — that exact
   trap crashed a container and rolled back a deploy on 2026-07-31. Relying on
   the default also sidesteps the `workflow`-OAuth-scope push block that has now
   bitten this epic three times.

**api-gateway** — one-line change, operator applies it:

5. `.github/workflows/staging.yml`: `LOGS_API_URL` port `8088` -> `50058`.
   This file can only be pushed by a credential with `workflow` OAuth scope, which
   neither the Claude lane nor the implementing agents have — the operator already
   applied the original `LOGS_API_URL` line themselves as commit `7646cf9` and can
   apply this edit the same way.

## Why this over TASK-EAR-214

It works against the **already-open** SG rule, so it needs no devops ticket and no
waiting. It also makes Logs consistent with every other service instead of
permanently cementing it as the one service serving gRPC from the HTTP port range.

TASK-EAR-214 stays **open as a fallback**, not cancelled: the SG contents here are
inferred from `ECS-CLOUD-MAP-STAGING-GUIDE.md`, not read from AWS directly (no CLI
or credentials in the Claude lane). If 50058 also times out, the guide is stale and
the SG genuinely needs a devops edit after all.

## Acceptance criteria

- `GOWORK=off go build -mod=readonly ./... && go vet ./... && go test ./...` green.
- A test or explicit verification that the gRPC listener binds 50058 when
  `GRPC_PORT` is unset, and that setting `PORT` alone no longer moves the gRPC port.
- The task definition declares both port mappings with correct `appProtocol` values.
- `env.names` and all workflow files untouched, stated in the PR body.
- PR body spells out the operator's one follow-up step (`LOGS_API_URL` -> `:50058`)
  and the required deploy order: **Logs first, then the gateway workflow edit**.

## Out of scope

- Any change to the audit read handler, query, or contract (all shipped in 207).
- Prod (`prod.yml`, prod task definition) — staging only, same as 207.
- Retiring the 8088 HTTP port mapping: Logs serves no HTTP today, but removing it
  is unrelated cleanup and would widen this change's blast radius.

## Blocks

- TASK-EAR-207 — deployed but never live-proven end to end.
- TASK-EAR-208 (Games-Labs-backoffice PR #76) — cannot demonstrate its live-data
  acceptance criterion until a real audit row renders.

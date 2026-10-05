# Games Labs Profile

Use with:

```bash
./ai-dev-office/run-agent.sh --profile games-labs <TASK_ID> reviewer
OFFICE_PROFILE=games-labs ./ai-dev-office/run-agent.sh <TASK_ID> auto
```

Overlay file: `profiles/games-labs.yaml`. Merge contract: `docs/config-profile-merge-contract.md`.

## When to use

Choose `games-labs` when the target workspace is the Games Lab Go microservice monorepo and you want:

- dependency guard enabled before reviewer/devops/auto runs
- SocratiCode context provider in optional mode
- shared-lib alignment checks across services

For non-Go or third-party projects, use `generic` or `go-microservice` instead. See [README.md](README.md).

## Target project rules (Games Lab)

When this profile is active in the Games Lab monorepo, agents must also follow the **target project's** root `AGENTS.md`, including:

### Handler message policy

- `handler message` must live only in `shared-lib`
- Do not add, move, or keep duplicate local handler-message logic in consumer services

### Service architecture

- Internal sync: gRPC
- External HTTP: api-gateway
- Async: RabbitMQ
- No cross-service database access

### Naming

- Services: `games-labs-<domain>`
- gRPC: `<Domain>Service`
- Proto: `gameslabs.<domain>.v1`
- Events: `<domain>.<action>`

## Dependency guard

`run-agent.sh` runs `scripts/check-service-dependencies.sh` before `reviewer`, `devops`, and `auto` when `dependency_guard.enabled` is true (default for this profile).

The guard enforces:

- no `go.work` in service roots
- aligned `github.com/SparqLab/shared-lib` versions (policy via `SHARED_LIB_POLICY`)
- Docker build rules: no `go mod tidy` in Dockerfile; `go build -mod=readonly`
- compile checks with `GOWORK=off` and `GOFLAGS=-mod=readonly`

Run manually:

```bash
ai-dev-office/scripts/check-service-dependencies.sh
ai-dev-office/tests/integration/dependency-guard.sh
```

### Environment variables

| Variable | Purpose |
|----------|---------|
| `SHARED_LIB_POLICY` | `aligned` (default), `latest`, or `pinned` |
| `GUARD_SHARED_LIB_VERSION` | Required version when `pinned` |
| `EXCLUDED_SERVICES` | Comma-separated skip list (default includes `Games-Labs-Provider` workaround) |
| `BUILD_TARGET` | `go build` target (default `./cmd`) |

## Bootstrap/sync

```bash
./ai-dev-office/scripts/sync-to-project.sh --target .. --profile games-labs
```

Installs framework core plus `scripts/check-service-dependencies.sh`.

## Related docs

- [README.md](README.md) — profile selection
- [../docs/getting-started.md](../docs/getting-started.md) — runner basics

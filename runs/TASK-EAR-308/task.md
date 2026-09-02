# TASK-EAR-308 — Decide where production ClickHouse lives before Monitoring ships to prod

## Type

investigation

## Workstream

devops

## Why this exists

Opened while assessing whether the Admin Monitoring epic could reach production. The
assumption going in was "prod does not support ClickHouse yet". **That is wrong, and the
truth is more awkward: prod is already wired, and it is wired to the same box as
staging.**

Nothing here blocks the remaining Monitoring work — TASK-EAR-285, 286, 291 and 292 are
all staging-side, and staging has a working ClickHouse. This task exists so the
production question stops being carried in someone's head.

## What is actually configured today

Verified on `origin/prod` and `origin/staging` of `Games-Labs-Logs`, plus the live
GitHub environment configuration.

| | `ecs/env.names` | workflow exports | effective `CLICKHOUSE_ADDR` |
|---|---|---|---|
| `main` | absent | absent | — (ClickHouse off) |
| `staging` | 4 names | 4 exported | `84.247.150.206:9000` — env variable, set 2026-08-31 |
| `prod` | 4 names | 4 exported | `84.247.150.206:9000` — **hardcoded fallback**, no variable set |

`prod.yml:87` reads `${{ vars.CLICKHOUSE_ADDR || '84.247.150.206:9000' }}` and line 104
repeats the default in the export. There is no `CLICKHOUSE_ADDR` variable in the
`production` environment, so **the fallback is what would be used.**

`cmd/main.go:47` documents ClickHouse as opt-in per deployment: without `CLICKHOUSE_ADDR`
the service logs a line and continues on PostgreSQL only. The fallback removes that
opt-in — prod cannot decline by omission.

## The three questions to answer

### Q1 · Should prod and staging share one ClickHouse instance?

They would today: same host, and `CLICKHOUSE_DATABASE` defaults to `gameslabs` on both.
Monitoring rows from production and from QA would land in the same database, so any
report figure is a blend of both unless something separates them. Decide: separate
instance, separate database, or an accepted blend with a documented reason.

### Q2 · What is `84.247.150.206`, and is it still ours?

A bare public IP, and `:9000` is ClickHouse's **native protocol port — plaintext**; the
TLS port is 9440. The address pattern matches the legacy Contabo estate, which the ECS
migration was meant to supersede. This is the same unanswered question as **D3** in
`docs/PROD-ISSUES-2026-08-15.md` ("is the legacy Contabo k3s cluster still running?").

If production monitoring data is about to be written to a legacy box, that should be a
decision rather than a default.

### Q3 · What credentials does it use?

**Neither the `staging` nor the `production` GitHub environment holds any ClickHouse
secret** — both contain only `POSTGRES_*` entries. So `CLICKHOUSE_USERNAME` falls back to
`default` and `CLICKHOUSE_PASSWORD` falls back to **empty** (`prod.yml:106-107`).

On the configuration alone that is an unauthenticated connection to a public IP over a
plaintext port. **Not probed** — no request was sent to that host, and confirming what it
actually accepts is part of this task, not a finding of it. A related concern was raised
once before as the "ClickHouse public-read" chip during the win-capture epic.

## Scope

- Answer Q1, Q2, Q3.
- Decide the production ClickHouse target and record it.
- Remove the hardcoded fallback from `prod.yml` either way — production infrastructure
  should not be selected by a literal in a workflow file. Prefer failing the deploy over
  silently defaulting.

## Out of scope

- Any change to the Monitoring projection, contracts, or frontend. Those are
  TASK-EAR-285/286/290/291 and are staging-side.

## Acceptance criteria

1. Q1, Q2 and Q3 are answered with evidence, not inference.
2. The production ClickHouse target is decided and recorded.
3. `prod.yml` no longer carries a hardcoded host fallback; an unset address fails the
   deploy or explicitly disables ClickHouse, whichever the decision requires.
4. If credentials are required, they exist as environment secrets rather than as
   defaults in the workflow.
5. `docs/PROD-ISSUES-2026-08-15.md` D3 is updated with whatever Q2 establishes.

## Dependencies

None. Deliberately independent of the Monitoring epic so that epic can finish on staging.

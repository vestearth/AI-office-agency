# TASK-EAR-207 — Audit read API A1b: Logs query path + api-gateway registration

## Type

feature

## Priority

high

## Context

A1b of the audit-read split. **Gated on TASK-EAR-201** (the `adminlogpb`
contract) being merged and shared-lib published — do not start before the
publish gate clears (AGENTS.md:275).

The store already exists and is filling: `admin_actions` table
(`Games-Labs-Logs/migrations/003_admin_actions.sql`), consumer
(`infrastructures/admin_actions_consumer.go:25`, wired `cmd/main.go:75-81`),
insert repo (`internal/core/repositories/admin_actions.go:19`), retention
(`repositories/retention.go:32`). This run adds the way to read it.

⚠️ **Branch reality**: the whole audit epic lives on Logs' `staging` branch
(PRs #3/#4/#5 merged there; `origin/main` predates all of it). Base this
work on `staging` and PR to `staging`, not main — verify with
`git log origin/main --oneline -3` before branching.

## Scope A — Games-Labs-Logs

1. **shared-lib bump** to the published version carrying `adminlogpb`. No
   `replace`; `go mod tidy`; commit go.mod+go.sum together; verify with
   `GOWORK=off go build -mod=readonly ./...` (AGENTS.md:282).
2. **Read repository**: `ListAdminActions(ctx, filter)` returning items +
   total, in `internal/core/repositories/admin_actions.go` alongside the
   existing insert. Filters: `target_user_id`, `actions []string`,
   `actor_id`, `outcome`, `limit`, `offset`. Order `occurred_at DESC` (the
   indexes are `(target_user_id, occurred_at DESC)` and
   `(action, occurred_at DESC)` — write the WHERE/ORDER so they are
   actually used; check with EXPLAIN if a local DB is available and say so
   if not). Total via a `COUNT(*)` over the same predicate.
   - Bind `actions` as an array predicate (`action = ANY($n)`), never
     string-concatenated SQL.
   - Clamp `limit`: default 10 (the modal's page size), max 100. A missing
     or absurd limit must not become an unbounded scan.
   - `before_state`/`after_state` are JSONB → decode into
     `map[string]any` for the handler to convert to `Struct`.
3. **Port**: add a read method to the ports interface
   (`internal/core/ports/repositories.go` — today Insert-only). Keep the
   insert path untouched; a separate reader interface is fine if it reads
   better.
4. **Service + gRPC handler**: implement `adminlogpb.AdminLogServiceServer`
   (new handler package alongside `internal/core/handlers/logshdl`,
   following that package's style) and register it in `cmd/main.go` next to
   the existing `logpb.LogsService` registration. Map rows → proto,
   including `map[string]any` → `structpb.NewStruct`; a Struct conversion
   error must degrade to an empty Struct + a log line, never fail the whole
   list.
5. **This service is append-only by design** — expose no mutation RPC, and
   say so in a comment on the service.

## Scope B — api-gateway (separate PR, same staging lane)

6. Register the new service in the gateway table
   (`gateway/grpc.go:80-102`) with a Logs endpoint config value. Today the
   gateway has **no Logs entry at all**, so this also needs the config
   field + env var (mirror how a neighbouring service's `*APIURL` is
   declared and consumed).
7. **Env plumbing, per the recorded traps**: add the var to `ecs/env.names`
   AND to the workflow env block so it is actually rendered
   (schedule-generator lesson: a console-only var vanishes on next deploy);
   keep it a plain string. **If the value is empty, skip registration with
   a warning — never `log.Fatal`** (ecs/env.names non-string crash lesson:
   an unset workflow env renders `""`, and a boot crash triggers an ECS
   circuit-breaker rollback of the whole gateway).
8. No route-order risk expected (single new path, no wildcard), but confirm
   the generated `*.pb.gw.go` mounts `/api/v1/admin/audit-events` and that
   nothing already claims it.

## Acceptance criteria

- `go build -mod=readonly ./...`, `go vet`, `go test ./...` green in both
  repos.
- Repository tests for the query: filter by target_user_id; filter by
  actions[]; outcome filter; limit clamping (0 → default, 1000 → 100);
  offset paging; total independent of limit; empty result is empty, not an
  error. If the repo has no DB-test harness, follow whatever pattern the
  repo does have and say explicitly which cases are covered where —
  do not fake DB behavior.
- Gateway: empty Logs URL → gateway still boots (test or documented
  reasoning), non-empty → route registered.
- **Post-deploy proof, not a green build** (the 4x-bitten class): after
  both deploy, curl the staging gateway
  `GET /api/v1/admin/audit-events?target_user_id=<devtest>&actions=user.vip_level.set`
  with a staff bearer and show real rows — the devtest player has VIP audit
  events from TASK-EAR-181's live publisher. Capture the response.
- Deploy order: Logs first, then gateway.

## Out of scope

- Publishers for the other five modal scopes (TASK-EAR-188 + new runs).
- FE wiring (TASK-EAR-208).
- Export endpoint, actor name/email resolution, retention changes.

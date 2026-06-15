# TASK-097: Provider admin List/Detail returns 500 ("Provider API is unavailable") while DB is connected and has data

## Short name
`provider-admin-500-rca`

## Type
bugfix (investigation-first)

## Priority
high

## Parent / Epic
- Parent: none
- Epic: Backoffice Provider Management

## Status

Pending RCA. Root cause not yet identified because the backend currently
swallows the real error. First deliverable is to make the error visible, then
fix the actual failure.

## Background

Backoffice **Provider List** page renders the table header but the body shows
`Provider API is unavailable. Please try again later.` (see screenshot in the
originating session). The same applies to the provider detail / games calls.

That frontend string is only produced when the backend returns HTTP/envelope
status `>= 500`:
- `Games-Labs-backoffice/app/composables/useAdminProviderApi.ts:119-121`
  (`if (status >= 500) return 'Provider API is unavailable. Please try again later.'`)

So this is a real **5xx**, not a third-party provider/game-vendor outage and not
a missing-data problem.

## Evidence gathered so far (what has been ruled OUT)

1. **Path is correct / route is deployed.** Live probe of
   `https://dev-api-gateway.gameslabs.app/api/v1/admin/provider` (and
   `/{id}`, `/{id}/games`) returns **401 `Missing authorization header`**, not
   404. A 404 would mean the route is not mounted; 401 proves the route exists
   and reaches auth. Gateway wires it at
   `api-gateway/gateway/grpc.go:92` and the proto pins
   `/api/v1/admin/provider` at
   `shared-lib/proto/admin/adminproviderpb/adminprovider.pb.gw.go:163`.
2. **"`getProvider` not in `/admingame/swagger`" is a red herring.** Each
   service has its own swagger doc (`api-gateway/gateway/docs/docs.go:45-61`).
   Provider admin lives in a separate doc at `/adminprovider/swagger`
   (confirmed `doc.json` → 200). `/admingame/swagger` only documents
   `admingamepb`.
3. **Provider service connects to DB at boot.** Provider log shows
   `2026/06/11 05:04:45 PostgreSQL connected` → not the nil-pool fallback at
   `Games-Labs-Provider/cmd/main.go:81-89`.
4. **Provider points at the correct DB.** Container `POSTGRES_*` env matches the
   DB the operator inspected (same host/db/user). Provider runs via Docker
   Compose service `games-labs-provider-dev`
   (`Games-Labs-Provider/docker-compose.dev.yml:11`); DB is external via
   `POSTGRES_HOST`.
5. **DB has rows.** Operator confirmed `providers` has data.
6. **No NULL-scan failure.** Both NULL-hunt queries returned 0 rows:
   - `providers` (created_at, updated_at, wallet_mode, status, all `supports_*`)
   - `provider_endpoints` (environment, api_base_url, created_at, updated_at)
   This also proves those columns **exist** (the queries referenced them and did
   not error), so "missing/renamed column" is ruled out for the read path in
   `Games-Labs-Provider/internal/repositories/provider.go:99-153`.

## Core problem (why this is hard, and the first thing to fix)

The real error is currently **invisible**:
- `adminproviderhdl.statusErr` for internal errors discards the underlying
  message and returns a generic `errormsg.InternalServer`:
  `Games-Labs-Provider/internal/handlers/adminproviderhdl/grpc.go:39-40`.
- The handlers do **not** `log` the underlying `err` before returning 500
  (`ListProvider` grpc.go:135, `GetProviderByID` grpc.go:206,
  `ListGamesByProviderID` grpc.go:242).
- The provider gRPC server is created with a bare `grpc.NewServer()` — **no
  recovery interceptor and no logging interceptor**
  (`Games-Labs-Provider/cmd/main.go:397`). A panic would also be invisible
  (and would crash the process rather than log).

Net effect: a 500 surfaces in the UI with zero diagnostic breadcrumbs in the
response body or logs.

## Remaining root-cause hypotheses (to confirm AFTER the error is made visible)

H1. **Gateway routes to a different provider instance than the one inspected.**
   The cloud gateway (`dev-api-gateway.gameslabs.app`) forwards to whatever
   `PROVIDER_API_URL` the *deployed* gateway holds — possibly the ArgoCD/k8s
   provider, not the operator's local Docker container. The operator inspected
   the Docker container; the failing request may hit a different instance. Must
   confirm which provider the failing gateway actually dials.
H2. **Game-enrichment latency → gateway timeout.** `ListProvider` loops every
   provider and makes a gRPC call to the Game service for each
   (`grpc.go:174-183`, `GAME_API_URL`). Per-call errors are swallowed, but if
   the Game service hangs (vs. fast-fails), cumulative latency can exceed the
   gateway deadline → 5xx/504. If `GAME_API_URL` is misconfigured/unreachable
   this is a prime suspect.
H3. **Provider gRPC unreachable from gateway** (wrong `PROVIDER_API_URL`,
   TLS/plaintext mismatch in `api-gateway/gateway/grpc.go:41-60`, port).
H4. **A scan/type error not covered by the NULL hunt** (e.g. an `id`/uuid value,
   or an unexpected value) — lower likelihood given evidence, keep on the list
   until the real error is read.

## Scope

### Target services

| Service | Role |
| --- | --- |
| `Games-Labs-Provider` | Surface real errors (logging + recovery interceptor), then fix the actual failure in handler/repo/enrichment. |
| `api-gateway` | If H1/H3 confirmed: verify/fix `PROVIDER_API_URL` and gRPC dial; confirm which backend the deployed gateway routes to. |
| `shared-lib` | Only if the error-surface fix needs an internal-error variant that carries a description. |
| `ai-dev-office` | Task status, RCA notes, verification evidence. |

### Likely affected files (RCA may expand this)

- `Games-Labs-Provider/internal/handlers/adminproviderhdl/grpc.go`
- `Games-Labs-Provider/cmd/main.go` (add recovery + logging unary interceptor)
- `Games-Labs-Provider/internal/repositories/provider.go` (NULL-safe / COALESCE hardening if relevant)
- `api-gateway/gateway/grpc.go` (only if H1/H3)
- `ai-dev-office/runs/TASK-097/*`

### Explicitly out of scope

- Rewording the frontend `Provider API is unavailable` message (separate UX task).
- Any change to game-vendor adapters (afb/1up/idg/sigma/ggsoft/vp).
- Local `replace github.com/SparqLab/shared-lib => ../shared-lib` directives.

## Acceptance criteria

- [ ] Provider gRPC server has a unary recovery interceptor (panic → logged
  `codes.Internal`, no process crash) and request/error logging.
- [ ] The internal-error path logs the underlying `err` (handler or interceptor)
  so the real cause is visible in provider logs.
- [ ] The actual root cause of the 500 is identified and documented in
  `verification-evidence.md` with the captured error text.
- [ ] The Provider List/Detail/Games admin endpoints return 200 with data for a
  valid staff token against the environment the backoffice actually calls.
- [ ] If H2 confirmed: game-enrichment cannot make the whole list 5xx (bounded
  per-call timeout and/or already-swallowed errors verified end to end).
- [ ] Focused tests cover the regression where applicable.

## Technical plan

1. **Make it visible first.** Add a unary recovery+logging interceptor in
   `cmd/main.go`; log the underlying `err` in the internal-error branches of
   `adminproviderhdl`. Deploy/rebuild the provider container.
2. **Reproduce with a valid staff token** against the same gateway the
   backoffice uses; capture the now-visible provider-side error and the HTTP
   status the gateway returns.
3. **Confirm H1** in parallel: read the deployed gateway's `PROVIDER_API_URL`
   and verify whether it points at the Docker container or the k8s instance.
4. **Identify** the failing line from the captured error and select the fix
   (enrichment timeout bound, gateway target, repo hardening, etc.).
5. **Fix + test + verify**; record evidence.

## Subtasks

| Order | ID | Agent | Description | Owned files | Parallel safe |
| --- | --- | --- | --- | --- | --- |
| 1 | `surface-error` | `debugger` | Add recovery+logging interceptor and error logging; rebuild; capture the real error. | `Games-Labs-Provider/cmd/main.go`, `Games-Labs-Provider/internal/handlers/adminproviderhdl/grpc.go` | false |
| 2 | `confirm-routing` | `debugger` | Confirm which provider instance the failing gateway dials (H1) and `GAME_API_URL`/`PROVIDER_API_URL` config (H2/H3). | none (config/infra inspection) | true |
| 3 | `fix-root-cause` | `dev` | Apply the fix for the confirmed cause and add focused regression tests. | TBD after RCA | false |
| 4 | `verify` | `reviewer` | Verify endpoints return 200 with data via the real gateway path; record evidence. | `ai-dev-office/runs/TASK-097/*` | false |

## Risks

| Risk | Mitigation |
| --- | --- |
| Adding the description back to internal errors leaks internals to clients. | Log full error server-side; keep client message generic, or gate detail behind non-prod env. |
| Fixing the wrong instance (Docker vs k8s). | Subtask 2 confirms the routed backend before any fix. |
| Panic recovery hides a real crash bug. | Recovery must log stack at error level so crashes remain visible. |

## Assignment

- Primary: `debugger`
- Parallel: `false`

Reason: investigation-first. The real error is currently swallowed, so RCA
(make-visible → reproduce → confirm routing) must complete before a code fix is
chosen. Scoped via the Claude manual advisory lane; not a configured runner.

## Next action

Run `debugger` to implement subtask 1 (`surface-error`) and capture the real
provider-side error.

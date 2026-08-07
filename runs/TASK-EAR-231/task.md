# TASK-EAR-231 — Auth password-reset audit publisher (`reset_password`, the last scope)

## Type

feature

## Priority

medium

## Context

The **sixth and final** scope of the player audit-log modal. Five are live end to
end: VIP Level, Grant Pass, Missions, E-Voucher (TASK-EAR-188/219/222/223) and
Wallet (TASK-EAR-226). This closes the epic's publisher work.

Scoped read-only on 2026-08-07; every file:line below was verified on
`origin/staging`.

**Backend first. FE binding is a follow-up run**, matching how TASK-EAR-219
preceded 222/223 and 226 preceded its own FE step.

## Owner — Games-Labs-Auth, not User

Despite the scope living next to user-management screens, the reset is Auth's:

- FE `Games-Labs-backoffice/.../player/edit/[id].vue:596` → `POST {gateway}/api/v1/admin/auth/password-reset`, body `{user_id}` only.
- Proto-declared grpc-gateway binding (`shared-lib/proto/admin/adminauthpb/adminauth.proto:46-56`) — **not** a raw mux, so metadata survives.
- Registered on the gRPC lane at `api-gateway/gateway/grpc.go:100`, under
  `runtime.WithMetadata(interceptor.MapMetadataInterceptor)` (`grpc.go:66`).
- Handler `Games-Labs-Auth/internal/core/handlers/adminauthhdl/grpc.go:84` →
  `authsvc.AdminSendPasswordReset` (`service.go:691`) → `ForgotPassword` (`:653`).
- Games-Labs-User has **zero** password-reset matches.

## Staff identity — already present, one line away

Same pattern as Wallet, and even shallower. `adminauthhdl/grpc.go:85` already runs:

```go
if st := auth.RequireStaffGRPC(ctx, auth.PERM_USER_MANAGEMENT); st != nil {
```

and `RequireStaffGRPC` → `RequireStaffMetadata` → `ConvertMetaDataToUserData`
already **returns `*TokenData`** — the handler simply discards it via
`if _, err := ...` (shared-lib `pkg/auth/auth.go:118-137`). Keep the `td` instead
of throwing it away.

Metadata is trustworthy: `api-gateway/middleware/identity_headers.go:12-33`
deletes client-supplied `userid`/`role`/`permissions`/`access` and rewrites them
from validated token context, and this path is **not** in SkipPaths
(`gateway/http.go:107-112`).

Only real plumbing cost: `AdminSendPasswordReset` is a **free function** taking
`as ports.AuthService`, called from `authhdl/grpc.go:141`. The publisher must be
threaded onto `handler` (`authhdl/grpc.go:26-35`) and into that signature.

## 🔴 What must never reach the audit store — and why it's structurally easy here

TASK-EAR-217 is what a secret in this table costs: staff bearer tokens sat in
`admin_actions` for six days and were served over the audit read API.

Must never be published: the 6-digit OTP (`service.go:682`), its bcrypt hash, the
`resetToken`/reset-session token (`service.go:733-738`), any password hash, and
`td.Access`.

**Favourable structure worth preserving:** all of those live inside the *service*.
The **handler only ever holds `req.GetUserId()`, the actor `td`, and the returned
error** — the OTP and the resolved email never surface to it. So publishing from
the handler is safe by construction. **Do not "helpfully" plumb the email or any
service internals up to the handler to enrich the event.** The player's email is
resolved at `service.go:696-706` and nothing in the modal needs it.

## Columns

Modal columns (`Games-Labs-backoffice/app/data/mock.ts`,
`getPlayerAuditLogDefinition`): `resetAt`, `sendVia`, `byAdmin`.

| Column | Source |
|---|---|
| `resetAt` | `occurredAt` |
| `byAdmin` | `td.UserId`, raw actor id — as every other scope renders it |
| `sendVia` | the literal `"email"` |

**`sendVia` is real here, unlike E-Voucher** — there is an actual SMTP delivery
path (`infrastructures/mail_smtp.go:20`). But there is no channel *field*
anywhere: the proto carries only `user_id`, the FE hardcodes
`resetChannel='email'` (`[id].vue:413-415`), and the SMS radio is disabled
(`[id].vue:948-951`). So publish a **server-side constant `"email"`**, never a
UI-supplied value — the client cannot choose, so it must not appear to.

## RabbitMQ

Connection exists (`infrastructures/rabbitmq.go`, wired `cmd/main.go:51-105`).
`RABBITMQ_URL` **is** in `ecs/env.names:8` and set in `staging.yml:85`, so it
reaches the container — Order's silent-death mode does not apply.

`RABBITMQ_QUEUE_ADMIN_ACTIONS` is **absent everywhere**: no `env.names` entry, no
config field, no accessor. Add it **with an explicit `if x == "" ` accessor
guard** — an envconfig `default:` tag does **not** fire on a set-but-empty var
(verified in envconfig v1.4.0, `envconfig.go:199`: `if def != "" && !ok`), and
`build-env-json.sh` renders any listed-but-unexported name as `""`. Auth's config
already uses the same lazy-struct + guard shape as User (`configs/config.go:48-91`).

⚠️ **Do not touch `.github/workflows/*`** — pushes there are rejected for lack of
`workflow` OAuth scope; this has blocked the epic five times. It is also
unnecessary: Games-Labs-User lists this same queue var in `env.names` and exports
it in **neither** workflow, relying purely on the guard.

## shared-lib bump required

Auth is on `v0.0.0-20260721035530-90df7e4d579b`, which **predates
`events/admin_action.go`**. Bump to `v0.0.0-20260807111620-c048249e829f` — what
the rest of the platform is on. The diff across Auth's imported packages touches
only `events/admin_action.go` (new) and `events/player_activity.go` (unused by
Auth; its only `events` use is `UserRegisteredEvent` at
`infrastructures/rabbitmq.go:47`). Low risk. AGENTS.md:282: no `replace`,
`go mod tidy`, commit `go.mod`+`go.sum` together.

## What makes this scope different

- **This is Auth's first audit surface** — migrations 000-010 have no audit table
  and there is no existing security log, so nothing is duplicated.
- **No rate limiting anywhere.** Auth has none and
  `api-gateway/middleware/ratelimit.go` is never wired. An unthrottled admin path
  that sends real email — which makes the `failed`/`denied` events the only
  visibility into abuse. Publish them.
- **Non-existent or email-less users are reachable and return errors
  deliberately** (`service.go:699`, `:704`). These are genuine `failed` outcomes
  worth publishing, using `TargetUserID` from the request even when no such user
  exists.

## Non-negotiables (carried from TASK-EAR-181/188/217/226)

- Publishing must **never block or fail** the reset it describes. Async,
  fire-and-forget, errors to a log line.
- Actor from gateway-validated metadata, never the request body.
- Publish `denied` and `failed` too, not only successes.
- **Never set `ActorAccess`** — it no longer exists at the bumped shared-lib
  version (retired in TASK-EAR-225), so this should be structurally impossible.
- No secrets in `before`/`after`. Ever.

## Acceptance criteria

- `auth.password_reset.send` publishes on success, failure and denial, with
  `After` carrying `{"send_via": "email"}` and nothing else sensitive.
- Tests following the User/Wallet pattern, including one asserting **no OTP,
  token, password hash or email address appears anywhere in the published event**
  — scan every field rather than checking named ones, as Order's code-leak test
  does.
- A test proving the handler still succeeds with no publisher configured.
- `GOWORK=off go build -mod=readonly ./... && go vet ./... && go test ./...` green.
- PR base `staging`, do not merge.
- Staging verification after merge+deploy: trigger a reset for the QA player, read
  it back via `GET /api/v1/admin/audit-events`, and **grep the raw response body
  for the OTP and for the player's email address** to prove neither leaked.
  ⚠️ `actions` must be **repeated** query params — comma-joined returns
  `total: 0` silently.

## Out of scope

- FE binding of the `reset_password` scope — follow-up run.
- Rate limiting the reset endpoint (real gap, its own ticket).
- Any change to the reset flow itself.

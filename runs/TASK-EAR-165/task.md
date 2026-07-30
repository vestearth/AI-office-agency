# TASK-EAR-165 — Bug: admin `last_login` shows "row last modified", not a real login time

## Type

bugfix

## Workstream

backend

## Priority

medium

## Created

2026-07-29

## Context

Found in passing during TASK-EAR-161's Contact/Device Info investigation (see
`runs/TASK-EAR-161/decision-record.md` §Two incidental findings). Not part of
that task's scope, so it was flagged rather than fixed.

## The bug

`Games-Labs-User/internal/core/handlers/adminuserhdl/grpc.go` maps the admin
API's `last_login` field from the row's `updated_at` timestamp, in **two**
places:

- `:115` — `LastLogin: timestamppb.New(r.UpdatedAt)`
- `:127` — `LastLogin: timestamppb.New(u.UpdatedAt)` (`adminUserItem`)

So every admin surface showing "Last Login" is actually showing **"the last
time this user row was modified"**. Any write to the user record — a status
change, a VIP-level grant, a profile edit, an admin action — silently bumps
the displayed "last login" to now.

This is worse than a blank field: it looks plausible and is likely already
being trusted by operators (e.g. to judge whether a player is active, or when
they last showed up before a support enquiry).

## Where the real value lives

`Games-Labs-User` has **no login timestamp at all** — confirmed, no
`last_login` column in any of its migrations.

The genuine value is `auth_devices.last_login_at` in **Games-Labs-Auth**
(`migrations/001_create_auth_tables.sql:23`), which is upserted on every login
and, since `010_auth_devices_one_row_per_user.sql`, holds one current row per
user. It is currently **write-only** — no RPC or read path exposes it
anywhere (confirmed by grep across Auth handlers, shared-lib, and api-gateway).

## Investigation required before choosing a fix

The fix shape depends on a fact that is **not yet verified**:

`Games-Labs-Auth/configs/config.go:36` and `Games-Labs-User/configs/config.go:29`
both default `POSTGRES_DB` to `gamelabs`, and Auth migration `009` comments
"Auth runtime uses public.users" — strong evidence the two services **share one
physical database**, but the runtime values come from env and this could not be
proven from the repo. **Verify against the deployed environment first**, because
it decides between:

- **Shared DB** → User's admin query can read `auth_devices.last_login_at`
  directly (cheap), though that means User reads a table Auth owns — a
  boundary question worth stating explicitly rather than doing silently.
- **Separate DBs** → needs a new Auth RPC exposing last-login per user, plus a
  User→Auth call on an admin list endpoint (watch the N+1: `adminUserItem` is
  called per row in `ListUser`, so a naive per-user call would be one Auth
  round-trip per listed player).

## Acceptance criteria

- Admin `last_login` reflects an actual login event, or is honestly empty when
  no login has been recorded — it must never show `updated_at` again.
- Both call sites (`:115` and `:127`) fixed; a fix to only one leaves the bug
  live on the other surface.
- If the value is genuinely unavailable for a user (never logged in, or device
  data absent because `ClientDevice` is optional and the client may not send
  it), the API returns an empty/unset timestamp rather than a fabricated one,
  and the FE renders the existing honest-empty style — do not substitute
  `created_at` or any other "close enough" field.
- The cross-service data-access decision (shared-DB read vs new Auth RPC) is
  stated explicitly in the output with its reasoning, not just implemented.
- If a new Auth RPC is chosen: no per-row N+1 on `ListUser` — batch it.
- Build/vet/test clean in every touched service.

## Out of scope

- Surfacing device_id / Serial to the admin UI — that is TASK-EAR-161's
  deferred decision, gated on the IP/Serial privacy policy. This task uses
  `auth_devices` only as a source for the login *timestamp*, and must not
  expose the device identifier itself.
- Any retention/deletion work on `sessions` or `auth_devices` (also part of
  the pending privacy policy).
- Backfilling historical login times — none exist to backfill; the field
  simply starts being correct going forward.

# TASK-EAR-188 — Admin action audit: remaining publishers (Order, Missions)

## Type

feature

## Workstream

backend

## Priority

medium

## Created

2026-08-01

## Epic

Admin action audit. Continues TASK-EAR-181, which built the contract, the sink,
and the first publisher, and was closed once those were verified end to end.

## Context — the foundation exists and is proven

TASK-EAR-181 delivered and verified on staging:

- **Contract**: `events.AdminActionEvent` in shared-lib (shared-lib#33, merged
  as `1a39df5`).
- **Sink**: `admin_actions` (Logs migration 003) with `UNIQUE(event_id)`,
  `InsertAdminAction` using `ON CONFLICT DO NOTHING`, a dedicated
  `AdminActionsConsumer` on queue `events.admin.actions`, and the table under
  the retention pruner. Games-Labs-Logs#5.
- **First publisher**: Games-Labs-User#11 — `UpdateUserStatus` and
  `SetUserVipLevel`.
- **Proof**: an operator VIP change on 2026-08-01 produced two real rows,
  covering the succeeded and failed paths, with a genuine staff actor and a
  correct before/after diff.

So this task is not design work. It is applying an established pattern to more
call sites.

## Scope

**In:**

1. **Order — e-voucher grant.** `GrantRedemptionItem` in `adminorderhdl`. This
   was named in TASK-EAR-181's acceptance criteria and is carried forward here
   by name rather than dropped.
2. **Missions — admin panels.** The player-facing admin writes: at minimum the
   mission/pass grant and reset actions surfaced on Player Detail. Enumerate
   them from `adminmission` handlers first and list what you chose to
   instrument and what you skipped.

**Out:** any change to the contract, the sink, or retention (all shipped);
read/admin APIs over `admin_actions` (a separate task once there is data worth
reading); Backoffice UI.

## The pattern to copy

`Games-Labs-User` is the reference implementation — read it before starting:

- `infrastructures/admin_action_publisher.go` — async, returns no error,
  recovers from panics, lazy self-healing connection, nil when RabbitMQ is
  unconfigured.
- `internal/core/handlers/adminuserhdl/audit.go` — `auditEvent`,
  `succeeded`/`failed`/`denied` helpers.
- `internal/core/handlers/adminuserhdl/audit_test.go` — the test shape.

**Non-negotiables carried from TASK-EAR-181:**

- **Publishing must never block or fail the admin write it describes.**
  Fire-and-forget after the write is decided; swallow publish errors into a log
  line. An audit gap is bad; a failed voucher grant because the audit broker
  hiccuped is worse.
- **Actor from gateway-validated metadata** (`auth.ConvertMetaDataToUserData` /
  `RequireStaffGRPC` context), never from the request body.
- **Fresh uuid per attempt** — the sink dedupes on `UNIQUE(event_id)`.
- **Publish denied and failed attempts, not only successes.**
- **Before-state must be the stored truth, not a display value.** In User this
  meant reading `GetProfile` rather than the masking `GetLevelStats`
  (TASK-EAR-106). Check each service for the equivalent trap before choosing a
  read.
- **Never put voucher codes, credentials, or tokens in `before`/`after`.** The
  audit store is long-lived and read by humans. An e-voucher grant should
  record *which item* and *to whom*, not the redeemable code.

## Deploy traps that already bit this epic once each

- Any **non-string** env var added to `ecs/env.names` kills the container on
  deploy: `build-env-json.sh` injects an empty value for anything the workflow
  does not define, and envconfig cannot parse `""` into an int or a Duration.
  Keep new config as strings parsed in accessors. This rolled back a deploy on
  2026-07-31.
- The queue name must match the sink's: `events.admin.actions`
  (`RABBITMQ_QUEUE_ADMIN_ACTIONS`, with the same empty-tolerant default on both
  sides).
- If the service pins shared-lib, pin the **merged main** SHA, not a branch
  commit.

## Acceptance Criteria

- Order's e-voucher grant publishes an audit event on success, failure, and
  denial, with the granted item identified but no redeemable code stored.
- The chosen Missions admin writes publish likewise; anything deliberately not
  instrumented is listed with a reason.
- Each publisher has tests following the User pattern, including one proving
  the handler still succeeds with no publisher configured.
- Verified on staging by performing each instrumented action and reading the
  resulting `admin_actions` rows — not by unit tests alone.
- `go build` / `go vet` / `go test ./...` green in every touched repo. PRs
  target `staging`.

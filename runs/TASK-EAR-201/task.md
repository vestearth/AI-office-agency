# TASK-EAR-201 — Audit read API A1a: shared-lib `adminlogpb` query contract

## Type

feature

## Priority

high

## Context

The admin-action audit trail (TASK-EAR-181 Phase 2) is **write-only today**.
Events have been landing in `admin_actions` (Games-Labs-Logs, staging) since
2026-08-01, but nothing anywhere can read them back: `ports/repositories.go`
exposes only `Insert*`, Logs' gRPC surface is `SaveLog`/`SaveLogsStream`
only, there is no `adminlogpb`, and api-gateway does not register Logs at
all (`gateway/grpc.go:80-102`).

Consequence: the Backoffice player audit modal (6 scopes, shipped on main)
is 100% mock and **cannot be wired for any scope** — not because publishers
are missing (VIP already publishes), but because there is no query path.
The read API is one piece of work that unblocks all six scopes at once.

This run is **A1a of the 3-run split**: contract only, stopping at the
AGENTS.md:275 publish gate. A1b = TASK-EAR-207 (Logs read path + gateway),
A2 = TASK-EAR-208 (wire the VIP scope as proof).

## Scope — `/Users/earth/Documents/GitHub/shared-lib` only

Create **`proto/admin/adminlogpb/adminlog.proto`** (new package, mirroring
the 7 existing `proto/admin/*` packages' style — imports, `basepb`
StatusResponse envelope, `go_package`, buf conventions).

### Service

```proto
service AdminLogService {
  // Cross-service admin action audit trail. Read-only; the store is
  // append-only (Games-Labs-Logs owns it, TASK-EAR-181).
  rpc ListAdminActions(ListAdminActionsRequest) returns (ListAdminActionsResponse) {
    option (google.api.http) = { get: "/api/v1/admin/audit-events" };
  }
}
```

`/api/v1/admin/...` is required, not cosmetic: api-gateway's
`RequireAdminAPIAccess` gates that prefix (`middleware/auth.go:182-212`),
so the staff gate comes for free. Do not invent a second path.

### Messages — mirror the storage columns exactly

Storage truth: `Games-Labs-Logs/migrations/003_admin_actions.sql:12-49`
(note the DB names `before_state`/`after_state` map to the event's
`Before`/`After`; the proto uses `before`/`after`). Event contract:
`shared-lib/events/admin_action.go:46-93`.

`ListAdminActionsRequest`:
- `string target_user_id = 1` — the modal's primary filter; the table is
  indexed for exactly this (`idx_admin_actions_target_user_id
  (target_user_id, occurred_at DESC)`).
- `repeated string actions = 2` — action[] filter, e.g.
  `["user.vip_level.set"]`. grpc-gateway maps this to repeated query params.
- `string actor_id = 3` — the other question the indexes serve ("what did
  this operator do"); not used by the modal yet, include it now so the
  contract does not need a second round.
- `string outcome = 4` — optional filter (`succeeded`/`failed`/`denied`);
  empty = all. The modal will send `succeeded` because its columns are
  before→after diffs.
- `int32 limit = 5`, `int32 offset = 6` — **server-side paging**. The modal
  currently slices client-side at 10/page; that must become a real query.

`AdminActionItem` — one field per stored column, same names as the event
contract: `event_id`, `schema_version`, `actor_id`, `actor_role`,
`actor_access`, `action`, `target_user_id`, `target_type`, `target_id`,
`outcome`, `reason`, `before`, `after`, `request_id`, `trace_id`,
`source_service`, `occurred_at`.

- **`before` and `after` MUST be `google.protobuf.Struct`** — deliberate:
  Struct passes JSON through with the publisher's own keys intact, while a
  typed message would force a per-action schema and the gateway would
  camelCase it. Each action writes its own shape (e.g.
  `user.vip_level.set` writes `{level, exp}` — verified at
  `Games-Labs-User/internal/core/handlers/adminuserhdl/grpc.go:250-253,292-295`),
  and consumers read per-action keys. Document this in a proto comment so
  the next reader does not "fix" it into a typed message.
- `occurred_at` = `google.protobuf.Timestamp`.

`ListAdminActionsResponse`:
- `basepb.StatusResponse status = 1`
- `repeated AdminActionItem items = 2`
- `int64 total = 3` — the modal renders "Showing 1 to N of M"; without a
  server total that footer cannot be honest.

### Generate

`make buf` (clean → `buf format -w` → `buf generate` → swagger). Commit the
`.proto` together with every generated artifact (`*.pb.go`,
`*_grpc.pb.go`, `*.pb.gw.go`, `*.swagger.json`, `swagger.pb.go`). Never
hand-edit generated files.

## Hard stop — publish gate

After the PR is ready: **STOP and ask the operator to publish/bump
shared-lib.** Do NOT touch Games-Labs-Logs, api-gateway, or the Backoffice
— those are TASK-EAR-207 / TASK-EAR-208, after the gate (AGENTS.md:275).

## Acceptance criteria

- New `proto/admin/adminlogpb/adminlog.proto` only; no existing proto
  modified.
- Field names match the stored columns / event contract 1:1 (a reviewer can
  diff the proto against `003_admin_actions.sql` and `admin_action.go`
  without translation).
- `before`/`after` are `Struct`, with the rationale in a comment.
- `make buf` clean; generated artifacts committed alongside.
- PR body states: additive-only (new package, no existing contract
  touched), the staff-gate-by-path-prefix reasoning, and that downstream
  work is gated on the operator's publish.
- Run ends at the publish request — zero downstream edits.

## Out of scope

- Logs repository/handler/registration, gateway registration, FE (later
  runs).
- Any write-path or publisher change (TASK-EAR-188 owns publishers).
- An actor name/email snapshot — the events store `actor_id` only today;
  changing that means touching the gateway metadata bridge and every
  publisher, which is its own decision, not a contract detail to smuggle in
  here.

# TASK-EAR-284 — Define and publish Admin Monitoring contracts

## Type

feature

## Workstream

backend

## Goal

Add the additive, typed shared-lib contract required by the Monitoring projection and publish it before any downstream implementation begins.

## Scope

- `shared-lib` owns the protobuf services, messages, event envelope, generated artifacts, and Swagger/gateway annotations.
- Define read-only monitoring-log and report query APIs under `/api/v1/admin/monitoring/*` and `/api/v1/admin/reports/*`.
- Requests support search, RFC3339 date range, endpoint-specific filters, bounded limit/offset, and allowlisted sorting; list responses include items and total.
- Event envelope includes safe identifiers, occurred time, source, action, target, immutable event ID, and correlation/operation ID where applicable.

## Acceptance criteria

1. Existing contracts remain wire-compatible; new APIs/messages are additive.
2. Event payloads contain no tokens, credentials, or unredacted sensitive data.
3. Generated protobuf, gateway, and Swagger artifacts are regenerated, never hand-edited.
4. Contract tests/build pass and a release version is published for consumers.
5. Downstream module bump instructions are recorded.

## Dependencies

None. This is the release gate for TASK-EAR-285 through TASK-EAR-291.

## Out of scope

- Implementing consumers, source publishers, gateway registration, or frontend changes.

# TASK-EAR-284 — Define and publish Admin Monitoring contracts

## Origin

Multica issue SPAR-19 — Monitoring: review and publish shared event contract.

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

## Implementation progress — 2026-08-27

- SPAR-19 / shared-lib PR #55 is the completed event-contract phase. It did
  not publish a Monitoring read API, so it is not evidence that this run is
  complete.
- Player Log and Report contracts are published in shared-lib merge commit
  `f095aa4060450e845ae991fe29e3295ea9a1da4b` (PR #56). The package is
  `shared-lib/proto/admin/monitoringpb`: `MonitoringService.ListPlayerLogs`
  is a read-only staff route at
  `/api/v1/admin/monitoring/player-logs/{log_type}`. It supports the eight
  Player Log types, filters, limit/offset, sort inputs, total,
  `coverage_start`, and declared partial-data state. Missing financial
  snapshots are optional fields, not zero values.
- Downstream order after shared-lib publication: `Games-Labs-Logs` implements
  the RPC and server-side filter/sort allowlists; `api-gateway` bumps
  shared-lib and registers the generated handler behind the existing admin
  authorization prefix; Backoffice consumes this endpoint only once the
  projection is live.
- `ReportsService` now provides list, entity detail, and paginated drill-down
  routes for player, game, provider, package, mission, special item, promotion,
  and redemption. The contracts do not make Report UI wiring ready by
  themselves: Logs and api-gateway must adopt this exact shared-lib commit and
  expose a live projection first.

# TASK-EAR-285 — Build Logs monitoring read projection

## Type

feature

## Workstream

backend

## Goal

Create the idempotent read projection in Games-Labs-Logs that persists monitoring events and supports reporting queries without cross-service database access.

## Scope

- `Games-Labs-Logs` only.
- Add migration, consumer, read model, indexes, repository, and tests.
- Deduplicate immutable event IDs and record projection freshness/partial-data semantics.

## Acceptance criteria

1. Re-delivery cannot create duplicate read rows.
2. Queries are indexed for event time, target user, entity, and reporting dimensions.
3. Migration and repository tests cover filtering, paging, aggregate correctness, and delayed events.
4. No source-service database is accessed directly.

## Dependencies

Blocked on TASK-EAR-284 shared-lib publication and version bump.

# TASK-EAR-293 — Add paged Player Game Activity API contract

## Type

feature

## Workstream

backend

## Goal

Extend the existing per-player `ListPlayerGameActivity` contract additively so Monitoring Player Detail can use real server pagination without a capped client-side fetch.

## Scope

- `shared-lib` and `Games-Labs-Game` only.
- Add an optional request offset and response total; preserve the existing first-page behavior when callers omit offset.
- Apply pagination in the authoritative round-lifecycle aggregation query and test all three sort modes.

## Acceptance criteria

1. Existing clients remain compatible.
2. Total is calculated before page slicing and limit/offset bounds are enforced.
3. Frequently played, last played, and top performance paginate in the database query.
4. Proto generation, focused tests, readonly build, and gateway contract behavior pass.

## Dependencies

Blocked on TASK-EAR-284 shared-lib publication.

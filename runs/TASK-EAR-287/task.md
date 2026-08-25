# TASK-EAR-287 — Publish Auth and User monitoring events

## Type

feature

## Workstream

backend

## Goal

Publish safe, post-commit account and VIP/status events from Auth and User into the shared monitoring event contract.

## Scope

- `Games-Labs-Auth` and `Games-Labs-User` only.
- Cover registration, login, logout, player status, and VIP changes.

## Acceptance criteria

1. Events are emitted only after the authoritative state transition commits.
2. Payloads contain required audit dimensions but no credentials/session values.
3. Retry behavior and publish failure policy are tested.

## Dependencies

Blocked on TASK-EAR-284 shared-lib publication and version bump.

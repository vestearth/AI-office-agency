# TASK-EAR-286 — Expose monitoring APIs through Logs and gateway

## Type

feature

## Workstream

backend

## Goal

Implement the published monitoring/report contract in Logs and register it through api-gateway with staff authorization.

## Scope

- `Games-Labs-Logs` and `api-gateway` only.
- Use the read projection from TASK-EAR-285.
- Register the new service through the existing Logs endpoint configuration and admin gate.

## Acceptance criteria

1. Every new endpoint is staff-gated and returns stable envelope/error behavior.
2. Search, date range, paging totals, and sort allowlists are enforced server-side.
3. Gateway route/contract tests pass.
4. No endpoint exposes audit credentials or raw secrets.

## Dependencies

Blocked on TASK-EAR-284 and TASK-EAR-285.

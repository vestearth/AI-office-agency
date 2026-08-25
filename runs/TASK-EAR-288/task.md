# TASK-EAR-288 — Publish Wallet and Order monitoring events

## Type

feature

## Workstream

backend

## Goal

Publish committed financial and commerce events from Wallet and Order for monitoring and reports.

## Scope

- `Games-Labs-Wallet` and `Games-Labs-Order` only.
- Cover committed wallet/free-coin, package purchase, and redemption activity.

## Acceptance criteria

1. Financial activity represents only successful committed mutations.
2. Events preserve currency, amount/direction, target, event ID, and operation/correlation identity where available.
3. Duplicate publish/retry cannot double-count the projection.
4. Focused service tests pass.

## Dependencies

Blocked on TASK-EAR-284 shared-lib publication and version bump.

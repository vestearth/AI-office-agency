# TASK-EAR-289 — Publish Game and Mission monitoring events

## Type

feature

## Workstream

backend

## Goal

Publish post-commit gameplay and mission events required for the monitoring projection.

## Scope

- `Games-Labs-Game` and `Games-Labs-Missions` only.
- Cover settled rounds plus mission progress, completion, reward claim, streak, and pass activity.

## Acceptance criteria

1. Gameplay metrics derive from settled authoritative rounds only.
2. Mission events distinguish progress, completion, claim, and admin activity.
3. Publisher failures/retries and payload correctness are tested.

## Dependencies

Blocked on TASK-EAR-284 shared-lib publication and version bump.

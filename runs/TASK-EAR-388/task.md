# TASK-EAR-388 — Player report summary from the existing user read

Parent: TASK-EAR-291. Owner: Games-Labs-backoffice.

## Problem

The monitoring player detail sidebar says summary data is not available. The
player list already loads that person from `GET /api/v1/admin/user`, which
returns username, level, referral code, status, lifetime top-up, lifetime GGR,
and exp. Win/Loss is not on that payload. The list already leaves it empty.

## Outcome

Opening a player report detail shows that player's existing user fields in the
sidebar. The "not available yet" summary copy is gone. Do not invent Win/Loss.

## Scope

- `Games-Labs-backoffice` only.
- Read the opened user. Do not add a Logs or User contract in this task.

## Acceptance

- The sidebar shows the fields `GET /api/v1/admin/user` already returns for that id.
- Win/Loss stays absent, not zero, until a later task publishes it.
- An authenticated admin-dev read of one player detail shows those fields.

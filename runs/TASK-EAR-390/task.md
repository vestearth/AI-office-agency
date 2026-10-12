# TASK-EAR-390 — Per-player provider turnover for the monitoring report

Parent: TASK-EAR-291. Owner: Games-Labs-Logs.

## Problem

The player report Provider tab says provider turnover is not available. The
provider report list is a catalog with round measures still unpublished.
Round outcomes used by the game report carry `game_id`, not a provider total
per user.

## Outcome

The Provider tab lists that player's turnover grouped by provider. A provider
with no captured rounds is absent, not a zero row invented from the catalog.
The unavailable message is gone.

## Scope

- `Games-Labs-Logs` owns the aggregate over settled rounds.
- Use a provider identity the round event or the existing game catalog already
  has. Do not invent one.
- `shared-lib` holds the new read if none exists. Publish before the consumer bump.
- `api-gateway` follows the module bump.
- `Games-Labs-backoffice` binds the Provider tab on
  `app/pages/admin/monitoring/report/player/[id].vue`.
- `Games-Labs-Game` is a read of the existing catalog only, unless the round
  event has no provider identity at all.

## Acceptance

- The tab shows provider rows for that player from Logs.
- Turnover is absent when the round projection cannot produce it, not zero.
- The unavailable copy on the Provider tab is gone.
- An authenticated admin-dev read of one player with captured rounds matches the API.

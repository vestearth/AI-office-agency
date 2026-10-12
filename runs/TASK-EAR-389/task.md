# TASK-EAR-389 — Per-player promotion history for the monitoring report

Parent: TASK-EAR-291. Owner: Games-Labs-Order.

## Problem

The player report Promotion tab says promotion history is not available. The
History tab already shows purchases, points, and coin transfers. It is not
this tab. The promotion drill-down is keyed by coupon, not by player.

## Outcome

The Promotion tab lists that player's promotion uses from Order. An empty
history is an empty table, not the unavailable message.

## Scope

- `Games-Labs-Order` owns the per-user read. Reuse stored coupon usage before
  adding a table.
- `shared-lib` holds a new RPC if none exists. Publish before the consumer bump.
- `api-gateway` follows the module bump.
- `Games-Labs-backoffice` binds the Promotion tab on
  `app/pages/admin/monitoring/report/player/[id].vue`.

## Acceptance

- The tab shows that player's promotion uses, with the coupon identity Order stores.
- The unavailable copy on the Promotion tab is gone.
- An authenticated admin-dev read of one player with a known coupon use matches Order.

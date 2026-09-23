# TASK-EAR-372 — Wire Player Log Redemption catalog columns

## Origin

Operator request 2026-09-21 on
`http://localhost:3000/admin/monitoring/player-log/redemption`.
The table already has Brand, Voucher Method, Collection Tag, Code/Link, and
Start-Ends, but the page hardcodes dashes. Item, Type, and Spent Point already
come from `ListPlayerLogs`.

## Type

feature

## Workstream

backend

## Priority

medium

## Goal

Fill Brand, Voucher Method, Collection Tag, and Start-Ends from the
`player.activity` snapshot taken at redeem/grant time. Keep Code/Link as `-`.
Do not put voucher codes or redeem links in the event.

## Scope

| Service | Why |
|---|---|
| `shared-lib` | Additive `RedemptionLogDetail` fields; `PlayerActivityEvent` start/end timestamps |
| `Games-Labs-Order` | `publishRedemptionClaimed` fills brand, voucher method, tag names, dates |
| `Games-Labs-Logs` | Map those payload fields onto `RedemptionLogDetail` |
| `Games-Labs-backoffice` | Stop hardcoding dashes; keep Code/Link blank |
| `api-gateway` | shared-lib bump only, after publish |

Out of scope: live catalog joins, Code/Link values, redemption *report* page,
ClickHouse schema changes (payload JSON is already stored).

## Contract

Additive fields on `monitoringpb.RedemptionLogDetail`:

- `brand = 7`
- `voucher_method = 8` (`Code` or `Link` for e-voucher; empty for gift)
- `collection_tags = 9` (names, not ids)
- `starts_at = 10`
- `ends_at = 11`

Event JSON already has `redemption_brand`, `voucher_method`, `collection_tags`.
Add `redemption_starts_at` / `redemption_ends_at`. Never add `code`.

## Rollout

1. Publish shared-lib.
2. Bump Logs + api-gateway + Order.
3. Deploy Logs (old payloads with `redemption_brand` start showing Brand).
4. Deploy Order (new claims get method/tags/dates).
5. Deploy backoffice.

## Acceptance

- Player log API returns the new fields when the payload has them.
- Historical events without the new keys stay empty, not fabricated.
- Gift rows have empty voucher method.
- Published events never contain the assigned voucher code.
- Backoffice maps Brand / Voucher Method / Collection Tag / Start-Ends; Code/Link stays `-`.

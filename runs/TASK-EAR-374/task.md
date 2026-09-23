# TASK-EAR-374 — Player Log Code/Link shows Code or Link only

## Origin

Operator follow-up on TASK-EAR-372, 2026-09-21. After deploy, Code/Link still
showed `-`. They asked whether that column can show only `Code` or `Link`,
not the redeemable voucher value. Parent: TASK-EAR-372.

## Type

feature

## Workstream

frontend

## Priority

medium

## Goal

On `/admin/monitoring/player-log/redemption`, the Code/Link column shows
`Code` or `Link` from the existing `voucher_method` snapshot. Gift rows and
missing snapshots stay `-`. Voucher codes and redeem URLs stay off
`player.activity` and off this column.

## Scope

| Service | Why |
|---|---|
| `Games-Labs-backoffice` | Map Code/Link from `voucherMethod`; whitelist `Code`/`Link` only |

Out of scope: proto/event changes, Order/Logs/api-gateway, putting codes on
the event, redemption report page, Android.

## Acceptance

- Code/Link renders `Code` or `Link` when `redemption.voucherMethod` is one of those two values.
- Any other value, including a leaked code string, renders `-`.
- Voucher Method column is unchanged.
- Tests assert the whitelist; they no longer require Code/Link to stay a hardcoded dash.

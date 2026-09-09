# TASK-EAR-345: Stamp Player Log VIP-at-settle and THB W/L at publish

## Type
feature

## Workstream
backend

## Priority
medium

## Created
2026-09-09

## Parent
TASK-EAR-289 leftover; TASK-EAR-342 W/L overlay. Not TASK-EAR-344 (Turnover UI).

## Goal
Gameplay Player Log VIP Level and THB W/L are facts stamped on `round.settled`
at Game publish time. Logs must not join current VIP or invent FX at query time.

## Locked decisions (operator 2026-09-09)
- Stamp at publish, never join at read.
- Wallet owns frozen coin→THB (same class as deposit `amount_thb_minor`).
- Do not invent a numeric coin→THB rate in Game. No catalog row until ops
  upsert `gameplay.coin_thb`. Missing rate → omit THB (dash).
- Identity conversion when the round's gameplay currency is already THB.
- User owns VIP. `vip_level.changed` on every **player** level change (EXP /
  Fast Pass). Admin `user.vip_level.set` already has `admin.action` — do not
  double-publish player.activity from the admin path.
- Game does not call User or Wallet on the settle hot path.
- Additive proto only. `Games-Lab-Android/` read-only.

## Scope
In: User, Wallet (catalog domain), Game, shared-lib monitoring proto, Logs
mapper, api-gateway pin after publish, Backoffice gameplay columns.

Out: Turnover (344), Android, query-time joins, seeding a fake COIN/THB number.

## Acceptance criteria
- EXP/Fast Pass level-up publishes `vip_level.changed`; same-level exp update
  and admin `UpdateLevelProgressFromAdmin` do not add a player.activity VIP row.
- Game stamps `VIPLevel` from a local snapshot; omit when unknown.
- Game stamps `WinLossTHB` from Wallet-owned rate cache or THB identity; omit
  when no rate and currency is not THB.
- `GameplayLogDetail` has optional `vip_level` and `win_loss_thb`.
- Backoffice shows those fields; absent stays dash. Zero THB is `+0` / `0`, not dash.
- Focused tests RED then GREEN. No `replace` in committed go.mod.

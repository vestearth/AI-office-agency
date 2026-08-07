# TASK-EAR-242 — Game Special Pass + Bet Limit backend contract

## Type

feature

## Workstream

backend-first (Game / shared-lib / api-gateway), then Backoffice wiring

## Priority

low

## Created

2026-08-08

## Origin

Follow-up opened by TASK-EAR-235 (Game/Group full connect). The Game edit
page's **Special Pass** (Bonus Point / Golden Pass) and **Bet Limit**
(min/max) tabs are design-approved UI with **no backend contract**:
`UpdateGameRequest` / `Game` in
`shared-lib/proto/admin/admingamepb/admingame.proto` carry none of these
fields, and `games` has no columns for them. As of EAR-235 the tabs are
permanently disabled with an honest "not connected" note — no fake save.

## Goal

Define and ship the contract so the tabs can be wired for real:

1. Product decision: what do Bonus Point / Golden Pass / bet min/max actually
   control (player-facing effect, who reads them)?
2. Schema: columns on `games` (or a side table) + idempotent migration
   (Game replays all migrations on boot — every statement idempotent).
3. Proto: additive fields on `Game` + `UpdateGameRequest` (mind proto3
   presence — bet limits and toggles need `optional` so partial updates don't
   wipe them; see EAR-227 wallet-balance presence precedent).
4. shared-lib publish → Game service → **api-gateway staging-lane bump**
   (gateway owns the wire format — bitten 5x).
5. Backoffice: re-enable the tabs, hydrate from GetGameByID, save via
   UpdateGame (always send the fields together with level/is_new/is_hot per
   the omit-keeps-existing rule).

While the contract is missing, do **not** invent local persistence
(TASK-EAR-235 AC #4).

## Also consider

`UpdateCategoryRequest.image_url` cannot clear a persisted category cover
(empty string ignored, no presence) — if operators need "remove cover", make
the field `optional string` in the same proto pass.

## Sources

- `ai-dev-office/runs/TASK-EAR-235/dev-2-output.yaml` (inventory)
- `Games-Labs-backoffice/app/pages/admin/games/edit/[id].vue` (disabled tabs)
- knowledge-base: Field Lineage — Games Categories Banners Splash

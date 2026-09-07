# TASK-EAR-326 — Stop the last three mock leaks on Player Detail

## Type

bugfix

## Workstream

frontend

## Priority

high

## Created

2026-09-07

## Parent / Epic

- Parent: none
- Epic: Player Detail backend wiring (TASK-EAR-144 / 177 / 179 / 193 / 255)
- Sequence: cleanup slice. Blocks nothing; **should land before** any further
  field wiring on this page, so the page stops asserting false values while
  new true ones are added.

## Goal

`admin/manage/player/Detail/[id].vue` renders a mixture of real API data and
`mockPlayerDetail` placeholders. Three placeholders still read as **this
player's real data** and are wrong for every player. Blank them, using the
rule already established on this page: a field owned by no loader, or by a
loader that has not succeeded, renders `—` / an empty table — never the mock
person's value.

This task adds **no new field wiring and no new endpoint**. It only removes
false output.

## Evidence that drove the scope

Read from the current checkout on 2026-09-07 (`main`, 6c7de77):

1. `blankBackedFields` blanks `contact.phone` and `contact.email` only
   (`Detail/[id].vue:55`). `contact.facebook` (`-`), `contact.line`
   (`u61hS6`) and `contact.address` (`591 Joanne Lane, aaa, BKK 01887`) fall
   through from `mockPlayerDetail` (`app/data/mock.ts:193-196`) and render at
   `Detail/[id].vue:1102-1110`. Because `mockPlayerDetail` falls back to
   `mockPlayersList[0]` for any unknown id and real ids are UUIDs
   (TASK-EAR-144), **every real player shows the same fake person's Line ID
   and street address.** Same defect class as TASK-EAR-179, which blanked the
   coin totals for exactly this reason but left the contact rows behind.
2. `player.summary.redeemDiamond` renders raw at `Detail/[id].vue:1517`, so
   every player shows `50 Diamond`, while its two neighbours in the same
   panel (`totalRedeemText`, `redeemPointText`) are already gated on
   `redeemOk`.
3. `allGameRows` returns `getPlayerGameRows(gameSubTab.value)` for
   *Frequently played* and *Last played* whenever their refs are still `null`
   (`Detail/[id].vue:733-739`) — which is the state both while loading and
   after `loadFrequentlyPlayedGameRows` / `loadLastPlayedGameRows` catch a
   failure, since neither catch assigns `[]` (`Detail/[id].vue:565-583`).
   The tables then show twelve invented games with invented win amounts.
   TASK-EAR-193 fixed exactly this for *Top Performance* and deleted its mock
   rows; the two sibling tabs were left on the old path.

## Locked decisions (operator 2026-09-07)

- **Reverses a prior documented decision.** TASK-EAR-159 and TASK-EAR-177
  recorded `redeemDiamond` as "deliberately untouched … no Diamond-redeem
  flow exists in any backend". That reasoning is the argument for blanking
  it, not for keeping it: TASK-EAR-179 blanked six coin totals on the same
  page for the same reason. The designed row stays; the value becomes `—`.
- Mock rows for the two game sub-tabs are **deleted**, not merely bypassed —
  the TASK-EAR-193 precedent. `getPlayerGameRows` then has no caller and goes
  with them.
- No Diamond-redeem flow, no Wallet aggregate contract, and no new Line /
  Facebook / Address source is designed in this run. Those stay open
  (P4 in the 2026-09-07 audit).
- The Android reference repo is untouched. No backend repo touched.

## Scope

Only `Games-Labs-backoffice`. Frontend-only; no API, proto, gateway, or
migration change, so nothing to sequence and no deploy order.

## Acceptance criteria

1. `contact.facebook`, `contact.line`, `contact.address` render `—` on every
   player, on a page with no loader for them.
2. `summary.redeemDiamond` renders `—`; the "Diamond" label and the panel
   layout are unchanged.
3. *Frequently played* and *Last played* render an empty table while loading
   and after a failed fetch; their catch handlers assign `[]` exactly as
   *Top Performance* does.
4. `PLAYER_GAMES_FREQ`, `PLAYER_GAMES_LAST` and `getPlayerGameRows` are gone
   from `app/data/mock.ts`, and `Detail/[id].vue` no longer imports it.
5. Regression tests fail on the pre-change source and pass after.
6. No designed component is replaced and no layout changes — the
   preserve-UX-design rule holds.

## Non-goals

- Wiring Register Date / Last Login / Lifetime GGR / Device Type / VIP
  thumbnail / game thumbnails (audit P2).
- The non-200 → `[]` masking in the history composables (audit P1) — a
  separate run; it changes a shared return contract across every history tab.
- Server-side pagination, date filters, Export (audit P3).

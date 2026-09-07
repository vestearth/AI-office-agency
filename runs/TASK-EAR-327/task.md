# TASK-EAR-327 — A failed history load must not render as "no transactions"

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
- Epic: Player Detail backend wiring (TASK-EAR-144 / 177 / 179 / 193 / 255 / 326)
- Sequence: follows TASK-EAR-326 (P0 of the 2026-09-07 audit). Independent of
  it in code; both touch `Detail/[id].vue`, so land 326 first to avoid a
  conflict.

## Goal

Every admin player-history composable turns an **in-envelope error on an
HTTP 200** into an empty array and returns normally. The page's loader then
reaches its success line and sets its state to `ok`, so the table renders the
*genuinely empty* copy — "No transactions found." — for a request that
actually failed. An admin reading that concludes the player has no purchases,
no points, no transfers.

The page already knows how to say the truth. `historyEmptyMessage` has three
distinct strings for loading / error / empty, and the audit-log modal has
"Could not load the audit log." Those branches are simply never reached,
because the failure is consumed one layer below.

Make the composables propagate the failure so the UI that already exists
lights up. Then give the Game sub-tabs the same three-way state, which they
have never had.

## Evidence that drove the scope

Read from the current checkout on 2026-09-07. Six sites swallow a non-200
body and return an empty page:

| File | Line | Returns |
| --- | --- | --- |
| `useAdminPlayerPointHistory.ts` | 125 | `{ items: [], total: 0 }` |
| `useAdminPlayerPurchaseHistory.ts` | 93 | `[]` |
| `useAdminPlayerSendCoinHistory.ts` | 92 | `{ items: [], total: 0 }` |
| `useAdminPlayerStorePurchases.ts` | 83 | `{ items: [], total: 0 }` (guards on `status !== 'success'`) |
| `useAdminPlayerGameActivity.ts` | 126 | `[]` |
| `useAdminPlayerAuditEvents.ts` | 536 | `{ rows: [], total: 0 }` |

Correction to the audit's count of seven: `fetchGameRowsPage` in the same
game-activity file (line 172) **already throws**, and has since TASK-EAR-283 /
293 — its comment states the rule this run generalises, "envelope errors throw
so the tab can show an error state distinct from a successful empty page".
That is the precedent for the approach below, not a defect. The uncapped
first-100 helper beside it, which Manage Player Detail uses, is the one that
still masked.

Two aggravating factors:

- `fetchAllPointHistory` and `fetchAllStorePurchases` page in a loop and stop
  when a page returns no items. A masked failure on **page 3** therefore ends
  the loop and returns pages 1-2 as if they were the complete history — a
  silently truncated total, not just an empty one.
- After TASK-EAR-326 the Game sub-tabs render an empty table on failure with
  **no message at all**, so loading, failure and genuinely-no-data are now
  indistinguishable there. TASK-EAR-326 deliberately deferred that to this
  run, which owns load-state semantics for the page.

## Approach

**Throw, do not restructure the return type.** Every page loader already sits
in a `try`/`catch` that sets its state to `error`, and both the history table
and the audit modal already render an error string from that state. A thrown
error on a non-200 body therefore reaches the correct UI with no call-site
change. A `{ ok, items, total }` result object would touch every call site to
reach the same place.

Each site throws inline — no shared error module. Nothing inspects the error
beyond logging it, so a new abstraction across six files would buy nothing.

## Locked decisions (operator 2026-09-07)

- A masked failure inside a paging loop is a **failure**, not a short page.
  Partial rows already fetched are discarded rather than presented as a total.
- Game sub-tabs get a load state and the same three-message contract the
  history table has. Copy mirrors `historyEmptyMessage`.
- `resolveActorIdentity` (`useAdminPlayerAuditEvents.ts:478`) is **not**
  changed. It is a best-effort display-name lookup that falls back to the raw
  actor id; returning `null` on a non-200 is correct there.
- `parseAdminPlayerDevice` is **not** changed. It also conflates "no
  `auth_devices` row" with "the call failed", but the Device panel has no
  error state at all and giving it one is a UI question, not a masking fix.
  Recorded as still open.

## Acceptance criteria

1. All six sites above throw on a non-200 / non-`success` envelope instead of
   returning empty, matching `fetchGameRowsPage`'s existing shape.
2. A failed load on any history sub-tab renders "Could not load this history"
   — not "No transactions found."
3. A failure on any page of `fetchAllPointHistory` / `fetchAllStorePurchases`
   propagates; no partial set is returned as complete.
4. A failed audit-events fetch renders "Could not load the audit log."
5. The Game sub-tabs carry loading / error / empty states with distinct copy,
   and a failed fetch shows the error one.
6. A genuinely empty result still renders the empty copy, on every surface —
   the fix must not turn "no rows" into "error".
7. Regression tests fail on the pre-change source and pass after.
8. No designed component replaced, no layout change.

## Non-goals

- Device panel error state (see locked decisions).
- Wiring any new field (audit P2), server-side pagination and the 5,000-row
  caps (audit P3), Wallet coin aggregates (audit P4).
- Retry / backoff behaviour. This run reports failure honestly; it does not
  change what happens next.

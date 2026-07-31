# TASK-EAR-177 — Player Detail history tabs still render mock rows under the "data unavailable" banner

## Type

bugfix

## Workstream

frontend

## Priority

high

## Created

2026-07-31

## Epic

Player admin de-mocking (TASK-EAR-130..174). Direct follow-up to TASK-EAR-144,
which removed this exact fallback for identity, wallet, pass and
`Purchase > Package` — and left the other six history sub-tabs behind.

## Context

Observed live on 2026-07-31 while smoking TASK-EAR-144 after it merged
(`b758b6d`, deploy green, in production).

With the identity load failing, `admin/manage/player/Detail/:id` renders 144's
red banner — *"Could not load this player. The fields below are unavailable —
do not treat them as this player's data."* — and then, directly underneath it,
a History table of **fabricated rows**: Feb-2026 dated entries like
"Play Game Turnover (30,000 coin) 50 Point", "Quest Daily log-in (03) 120
Point", "Level Up Up to VIP (3) 200 Point".

That is worse than an incomplete page. The page states in red that its data is
not this player's, and immediately contradicts itself with a table that looks
exactly like a real transaction ledger. An operator who scrolls past the banner
has no way to tell the rows are invented.

## Root cause — verified in source

`Detail/[id].vue:492-514`, the `historyTable` computed. Each API-backed tab
returns real rows **only when its ref is non-null**, and the computed ends with:

```
  return table          // :514 — getPlayerHistoryTable(mainTab, subTab) = MOCK
```

`getPlayerHistoryTable` (`app/data/mock.ts:450`) is the mock ledger.

The refs stay null on failure because the loaders swallow the error, e.g.
`loadEarnedPointRows` (`Detail/[id].vue:404-412`):

```
  catch (e) {
    console.error('[player/detail] earned point history load failed:', e)
  }                     // ref left null -> historyTable falls through to mock
```

**TASK-EAR-144 already fixed this for exactly one tab.**
`loadPurchasePackageRows` (`:351-361`) is the outlier that behaves correctly:

```
  catch (e) {
    // TASK-EAR-144: a failed order fetch must NOT fall through to the mock
    // ledger — fabricated amounts/coupon codes on a money view. Empty instead.
    console.error('[player/detail] purchase history load failed:', e)
    purchasePackageRows.value = []
  }
```

That is why `Purchase > Package` correctly showed "Showing 0 to 0 of 0 entries"
in the same session where the other tabs showed mock rows. The pattern is
already in the file, applied once.

## Affected sub-tabs

All seven exist and all are API-backed, so none of this is "no backend yet":

| tab | loader | on failure today |
| --- | --- | --- |
| Purchase > Package | `:351` | `[]` — **already correct (144)** |
| Purchase > Special Pass | `:363`-ish | mock |
| Purchase > Limited Avatar | ” | mock |
| Earned > Point | `:404` | mock |
| Redeem > Point | `:414` | mock |
| Send coin > Sent | ” | mock |
| Send coin > Received | ” | mock |

Confirm each loader's line number when implementing; only `Package` was read
line-by-line for this brief.

## Objective

No fabricated transaction row can reach the screen. A tab that failed to load
must say so, and must not be indistinguishable from a tab that is genuinely
empty.

## Required work

1. **Kill the fallback.** The `return table` at `:514` should not be able to
   serve mock rows for an API-backed tab. Whether that means deleting the
   fallback outright or returning `{ columns, rows: [] }` is the implementer's
   call — state which and why.

2. **Distinguish the three states, do not just copy `[]` everywhere.**
   `null` currently conflates *still loading*, *load failed*, and *genuinely
   empty*. 144's `[]` on `Package` is a strict improvement over mock but still
   asserts something false: "0 entries" reads as "this player has no
   purchases", when the truth is "we could not find out". Follow what 144 did
   for identity/wallet/pass **in this same file** — track load state per
   section and show the failure — rather than the narrower `[]` it used for
   Package. Bringing `Package` up to the same standard is in scope.

3. **Make the failure visible in the table area**, not only in the page-level
   banner. The banner fires on *identity* failure; a history tab can fail on
   its own while identity is fine, and today that is silent.

4. **Preserve the UX design.** Standing house rule, and it has already bitten
   this page's epic once: change the data source and state handling, do not
   restyle or restructure the designed table, tabs or Summary panel.

## Also check — same class, seen in the same session

With identity failed, the **Summary sidebar kept showing numbers**: Total Coins
Received 1,564, Total Coins Wager 1,564 (the same value twice — a mock tell),
Total Redeem "5 Time / 50 Diamond / 104 Point", and a Golden Pass entry, while
every field in the main column had correctly dashed to `—`.

Determine whether those are mock or real-but-stale, and treat them the same way
as the history rows. Do not assume — read the loader.

## Acceptance criteria

- With every history API failing, no sub-tab renders a mock row.
- A failed tab is visually distinguishable from an empty one.
- `Purchase > Package` no longer reports a bare "0 entries" for a failed fetch.
- Summary sidebar resolved: either shown to be real, or given the same
  treatment, with the finding recorded either way.
- No designed component restyled or restructured.
- `npm run build` clean, no new `WARN Duplicated imports`.

## Verification

Testable with no backend: point the app at a dead gateway (or run with an
invalid token so every call 401s) and walk all seven sub-tabs. Today that
produces mock rows under a red banner; afterwards it must not.

## Out of scope

- The Detail pagination fix — shipped in TASK-EAR-144 (`b758b6d`), though note
  its "rows 11+ reachable" claim was never confirmed at runtime for the same
  reason this page is hard to populate; see
  `runs/TASK-EAR-144/verification-evidence.md`.
- Fields that are mock because **no backend exists** (Device Info/IP, Lifetime
  GGR, Game > Top Performance win stats, referral code) — a different problem
  with a different fix.
- Any backend, proto or gateway change.

## Notes

Found 2026-07-31 during the post-merge smoke of TASK-EAR-144. Claude advisory
lane. Evidence: `runs/TASK-EAR-144/verification-evidence.md`, final section.

Priority is high rather than medium because this is live in production now and
the failure mode is *confidently wrong data on a page an operator uses to make
decisions about a real player's account* — not a cosmetic gap.

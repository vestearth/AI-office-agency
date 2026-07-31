# TASK-EAR-177 — verification evidence

Run date: 2026-07-31. Lane: Claude advisory (manual).
Commit `e838f38` → PR #64 → merged by the operator 2026-07-31T07:04:10Z as
`df8654f`; the backoffice "Build and Deploy" run for `df8654f` completed
**conclusion=success**, read from the Actions API. `e838f38` confirmed an
ancestor of `origin/main`. Backoffice `main` is the live k3s/ArgoCD lane, so
this is in production.

## 1. The failure path, checked live

Local dev server off the branch, dummy `localStorage` token so every gateway
call 401s (no password entered — the 401s *are* the condition under test).
Loaded `/admin/manage/player/Detail/1?tab=history`:

- The table body rendered exactly one row, the message
  **"Could not load this history — the table is not showing this player's
  transactions."** in error red — where it previously rendered Feb-2026 mock
  transactions.
- `Showing 0 to 0 of 0 entries`.
- Summary → Total Redeem rendered **`— Time | 50 Diamond | —`**: the two
  loader-owned values dashed, `redeemDiamond` deliberately left as-is.

Before the fix, the same conditions produced "Play Game Turnover (30,000 coin)
50 Point", "Quest Daily log-in (03) 120 Point" and "Level Up Up to VIP (3) 200
Point" — sitting directly beneath TASK-EAR-144's red banner saying the data is
not this player's.

## 2. Why the other five tabs were not clicked through

Stated so nobody reads more into the runtime check than it covers. Every
history loader is gated behind an identity load that needs a real admin token,
so with a dummy token the tabs cannot be populated — there is no success state
to click into. Two workarounds were tried and abandoned:

- Stubbing `window.fetch` to inject rows: the loaders have already run by the
  time a stub can be installed, and re-running them needs a remount, which
  means a full page load, which wipes the stub.
- Driving the sub-tabs by matching button text: the sidebar contains entries
  with the same labels ("Purchase", "Package", "Point"), so the clicks kept
  landing on navigation and leaving the page.

That is why the coverage went into a source-level test instead of more
clicking.

## 3. Regression test — and proof it can fail

`tests/playerDetailHistoryFallback.test.mjs`, 6 tests, covering all six tabs in
the repo's existing source-reading convention. Only writable because
TASK-EAR-176 landed the alias-resolving test runner earlier the same day.

It asserts: every loader declares its own `LoadState`; every loader marks both
`'ok'` and `'error'`; the `historyState !== 'ok'` guard exists and `empty`
carries columns but no rows; loading / failed / genuinely empty are
distinguishable and the failed case is error-red; switching player resets
states as well as rows; and the two loader-owned Summary aggregates dash while
`redeemDiamond` stays.

**Mutation-checked rather than merely observed passing.** Temporarily replacing
the guard with `if (false) return empty`:

    ✖ a history tab that has not loaded renders no rows at all
    tests 6, pass 5, fail 1

Restored, then re-run: `tests 6, pass 6, fail 0`, with a clean diff confirmed
afterwards.

## 4. Suite and build

- `npm test` on the merged `main`: **172 / 172 / 0** (166 before this run's 6).
- `npm run build` clean; no new `WARN Duplicated imports`; the two remaining
  warnings are the pre-existing `promotion/coupon-edit` route-name collision
  and a chunk-size note.
- No designed component restyled or restructured — the only template addition
  is an empty-state row inside the existing table.

## 5. Deliberately not fixed, and why it is recorded rather than tidied

The Summary sidebar turned out to be two different problems, not one:

| field | owner | outcome |
| --- | --- | --- |
| `totalRedeem`, `redeemPoint` | `loadRedeemPointHistory` | fixed — dash on failure |
| `totalCoinsReceived`, `totalCoinsWager` | no API at all | left as mock |
| `redeemDiamond` | no Diamond-redeem flow exists in any backend | left as mock |

Dashing all five would have looked tidier and hidden a real backend gap. The
second group belongs to the "mock because no backend exists" class that
TASK-EAR-174 and this run's own brief both deferred; `blankBackedFields` in
`Detail/[id].vue` is where that work would start if it is ever taken on.

Both 1,564 values appearing in two different Summary cards is the mock tell
that flagged them.

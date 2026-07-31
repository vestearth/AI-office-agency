# TASK-EAR-144 — verification evidence

Run date: 2026-07-31. Lane: Claude advisory (manual).
Rebased commit `3a8162c` → PR #62 → merged by the operator at
2026-07-31T04:54:37Z as `b758b6d`; the backoffice "Build and Deploy" run for
`b758b6d` completed **conclusion=success**, read from the Actions API.
Backoffice `main` is the live k3s/ArgoCD lane, so this is in production.

## Verified before merge

- `npm run build` clean; no new `WARN Duplicated imports`.
- TASK-EAR-174's `assertApiEnvelopeOK` / `walletBalanceConfirmed` intact;
  `dd951fa`'s old local `assertEnvelopeOK` name gone.
- TASK-EAR-175's `ResizeObserver` height sync intact (the conflict resolution
  most at risk of silently reverting it).
- No orphaned `historyGoPage` / `gameGoPage` handlers left behind.

## Verified at runtime — the mock-fallback half

Local dev server off merged `main`, dummy `localStorage` token to pass the route
guard (no password entered), so every gateway call 401s. Loaded
`/admin/manage/player/Detail/1`:

- The error banner renders: *"Could not load this player. The fields below are
  unavailable — do not treat them as this player's data."*
- Every loader-owned field shows `—` instead of a mock value: User Name,
  Referral code, Status account, Level VIP, Turnover Coin, and all three Wallet
  rows (Point / Diamond / Coin), plus Phone and Email under Contact Info.
- `Purchase > Package` reports "Showing 0 to 0 of 0 entries" rather than
  falling back to the mock ledger — the specific fallback this run removed.

That is the headline defect fixed and confirmed against real behaviour.

## NOT verified at runtime — the pagination half

**Rows 11+ being reachable was not demonstrated.** Recorded plainly rather than
implied, because this is already in production.

What blocked it: every history tab's loader is gated behind an identity load
that requires a real admin token, so with a dummy token the tables fall back to
3 mock rows — one page, no second page to click. Stubbing `window.fetch` to
inject 25 rows did not get there either; the loaders had already run and
re-triggering them needs a remount, which means a full page load, which wipes
the stub. Driving the sub-tabs by matching button text then kept selecting
sidebar entries that share the same labels ("Purchase", "Package", "Point").

What the fix rests on instead, which is static but not weak:

- `AdminDataTablePagination.vue:29-30` declares
  `defineModel<number>('currentPage', { required: true })` and
  `defineModel<number>('perPage', { required: true })`, and the component emits
  no `go-page` anywhere.
- The previous binding was `:current-page` + `@go-page`, i.e. a one-way prop
  plus a listener for an event that is never emitted — so a page change had no
  path back into the page's `currentPage` ref. Pagination is computed purely
  client-side from that ref (`Detail/[id].vue:530`), so it could never advance.
- Both tables now bind `v-model:current-page` and `v-model:per-page`
  (`Detail/[id].vue:1034` history, `:1222` game).

The failure mode was structural rather than conditional, and the fix is the
binding the component's own contract requires. But it is inference, not
observation, and someone with a real admin session on a player with more than
10 history rows should click page 2 once and close this out.

## Also observed, out of scope — worth its own run

With identity failing, the History tabs still render **mock rows** (Feb-2026
dated "Play Game Turnover", "Quest Daily log-in", "Level Up" entries) *beneath*
the banner that says the data is unavailable. TASK-EAR-144 removed the mock
fallback for identity, wallet, pass and `Purchase > Package`; the Earned /
Redeem / Send-coin tabs came later with TASK-EAR-159 and still fall back.

So the page can currently show a red "do not treat this as real data" banner
directly above a table of fabricated rows — self-contradicting rather than
merely incomplete. This is the wider surface TASK-EAR-174 recorded as needing
its own task, and it is now the last known mock-fallback on this page.

# TASK-EAR-174 — Player admin: stop failures from presenting as success

## Type

bugfix

## Workstream

frontend

## Priority

high

## Created

2026-07-30

## Epic

Player admin API wiring (TASK-EAR-130..172). Those tasks replaced every
fake-success *panel* with a real API call. This one fixes the layer above them:
the panels now really call the backend, but a **rejected** call can still look
like it succeeded.

## Context

A three-way audit of `admin/manage/player` (list / edit / Detail) found the
wiring itself is genuinely done — all 5 write buttons on the edit page issue
real mutations and all 4 delegated panels do real reads. The remaining defects
are in feedback and failure handling, and they cluster on **money and
account-security paths**, which is why they are grouped into one task.

All three findings below were verified directly in the source, not inferred.

## Objective

Make a failed player-admin operation *look* failed, and make it impossible to
write fabricated wallet numbers into a real wallet.

## Scope

`Games-Labs-backoffice` only. No backend, proto, or gateway change. No new
component, no redesign.

**Preserve UX design — wire/behaviour only.** Per the standing house rule, do
not restyle or restructure the designed panels; the toast component already
supports both states and needs no change.

---

## Part 1 — Failure paths must use the error toast (9 call sites)

`openAdminSaveToast()` routes to variant `'success'`
(`app/composables/useAdminSaveFeedback.ts:57-59`), and
`AdminSuccessToast.vue:27-37` paints that as a green box with a check icon and
the literal title **"Success!"**. So today an operator who mis-sets a wallet
balance and gets a 403 sees a green success popup.

`openAdminErrorToast()` already exists at `useAdminSaveFeedback.ts:62-64` and
its own doc comment says *"use for failures so they don't look like a
success."* It is used in 6 other files in this repo but **never once** on the
player edit page or its panels.

Swap these **failure-branch** calls to `openAdminErrorToast` (leave every
success-branch call alone):

| file | line |
| --- | --- |
| `app/pages/admin/manage/player/edit/[id].vue` | 532, 594, 624 |
| `app/pages/admin/manage/player/index.vue` | 322, 333 |
| `app/components/SendVoucherPanel.vue` | 133 |
| `app/components/PlayerVipLevelPanel.vue` | 101 |
| `app/components/GrantPassPanel.vue` | 155 |
| `app/components/CompleteMissionPanel.vue` | 133 |

**Judgment call, decided here so the implementer does not have to guess:** the
last three are `else` branches of `if (failed.length === 0)` over a multi-item
loop, so they also fire on **partial** success (e.g. 4 of 5 granted). Use
`openAdminErrorToast` for them anyway — an operator must notice that something
failed, and the message text already carries the count
(`CompleteMissionPanel.vue:133` renders "Updated 4/5. Failed — …").

**Do NOT add a third toast variant.** `AdminToastVariant` is
`'success' | 'error'` (`useAdminSaveFeedback.ts:41`) and
`AdminSuccessToast.vue` branches on a single `isError` boolean. A 'warning'
state would mean touching the shared toast component for every other caller —
out of scope.

## Part 2 — Three writes must validate the response envelope

These APIs return errors **inside HTTP 200**. That is not hypothetical: the
wallet *GET* parser on this very page explicitly handles `{success:false}` and
`{status:{code:N}}` envelopes (`edit/[id].vue:260-266`), so the shape exists in
production traffic.

The page already has the right helper — `assertEnvelopeOK`
(`edit/[id].vue:492-497`) — and already applies it to the status PATCH (`:525`)
and the password-reset POST (`:619`). `CompleteMissionPanel.vue:121` shows the
same idea inside a panel (`if (result?.status && result.status !== 'success')
throw`).

Apply equivalent validation to the three that skip it:

| write | site | why it matters |
| --- | --- | --- |
| Wallet balance `PATCH` | `edit/[id].vue:577-590` — `await $fetch(...)` then straight to `openAdminSaveToast('Wallet updated successfully.')` | money path |
| VIP level `PATCH` | `PlayerVipLevelPanel.vue:93-96`; `setVipLevel` returns `void` (`useAdminVipLevel.ts:58-64`) so there is nothing to inspect — capture and check the response | also optimistically sets `savedLevel` (`:94`) before `loadVip()` quietly reverts it |
| Give-pass `POST` | `GrantPassPanel.vue:145-152`; `grantPass` returns `Promise<void>` (`useAdminPlayerMissionApi.ts:103-109`) — same change | grants a paid item |

Where a composable currently returns `void`, change it to return the parsed
response so the caller can assert. That is the minimal change; do not
restructure the composables further.

## Part 3 — Never let mock wallet values reach a real wallet write

`watch(player, ...)` (`edit/[id].vue:411-427`) seeds `walletValues` from
`p.wallet`, i.e. `mockPlayerDetail().wallet` — diamond 56 / point 90 /
coin 90054 (`app/data/mock.ts:215-221`).

When the balance GET fails, **that seed is left in place**: the unexpected-shape
branch (`:385-388`) and the catch (`:390-393`) both set
`walletBalanceFetchError` but neither clears `walletValues`. And the button is
`:disabled="walletSavePending"` only (`:911`), so it stays clickable.

Net effect today: on a wallet GET failure the operator sees editable fields
holding **fabricated numbers** and can Save them straight into the real wallet.
The small red error text at `:748` is the only warning.

Required: when the balance GET fails or returns an unparseable body, clear the
fields to a blank/zero state AND disable the Edit/Save button while
`walletBalanceFetchError` is set. Failing closed is correct here — a wallet
write with no confirmed current balance should not be possible.

Also fix the same class of problem one line over:
`walletBalanceResourceId` (`:213-217`) resolves the path segment for **both**
the balance GET and the balance PATCH out of `mockPlayerDetail().wallet.balanceId`.
It only works because `mock.ts:217` happens to echo the route id — and
`mock.ts:216` admits it (`"mock = player id; replace when API returns wallet
id"`). Use `playerId` directly. A money path must not resolve its target id
through the mock module.

---

## Out of scope (deliberately — do not fold these in)

- **Detail page pagination mis-wiring.** `Detail/[id].vue:886` and `:1070` bind
  `:current-page` + `@go-page`, but `AdminDataTablePagination` uses
  `defineModel` and never emits `go-page`, so rows 11+ are unreachable.
  Real bug, different file, different cause — needs its own run.
- **Audit Log modal.** All 6 scopes are mock and it shows the *wrong player* in
  its header. Blocked backend-first: there is no admin audit-log endpoint in
  any proto (`/api/v1/logs` is the Games-Labs-Logs ingest service, not an
  admin read API).
- **Silent mock fallback on the Detail page** loaders. Same class of problem as
  Part 3 but a much wider surface (wallet, VIP turnover, contact, every history
  tab) — worth its own task so this one stays reviewable.
- Every field that is mock because **no backend exists**: Device Info/IP, coin
  aggregates, Lifetime GGR, Game→Top Performance win stats, referral code
  (an unlaunched feature — the identifier exists nowhere in the User service).
- The `lifetime_topup` **two-implementations** finding (admin detail computes it
  live via Wallet `SumLifetimeTopup`; the list page reads a never-written
  column, so it is always 0). Backend inconsistency, not a FE fix, and a naive
  fix would be N+1 Wallet RPCs per list row.

## Done when

1. All 9 failure-branch sites use `openAdminErrorToast`; every success branch
   still uses `openAdminSaveToast`.
2. Wallet PATCH, VIP PATCH and give-pass POST all reject a 200-with-error-body
   and surface it as an error toast.
3. A failed wallet GET leaves no mock values in the inputs and the Edit/Save
   button is disabled.
4. `walletBalanceResourceId` no longer reads from the mock module.
5. `pnpm build` (or the repo's standard build) clean, and no new
   `WARN Duplicated imports` (a real trap here — see `app/utils/apiError.ts`,
   where TASK-EAR-166 had to avoid the name `apiErrorMessage` because
   `useVipLevelGames.ts` already exports it at module scope).

## Verification notes for the implementer

Merging to backoffice `main` is a **live deploy** (k3s/ArgoCD) — it is not the
no-deploy lane the other repos have. Treat it accordingly.

The toast behaviour is testable without a backend: temporarily point a write at
a bad URL and confirm a red box with an X icon appears, not a green "Success!".

## Notes

Claude advisory lane.

Grouped as one task rather than three because all three findings are the same
underlying defect — the UI asserting success it has not verified — on the same
two money paths, and the correct pattern for each already exists a few lines
away in the same files.

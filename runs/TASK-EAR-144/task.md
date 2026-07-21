# TASK-EAR-144: Player admin — kill mock fallback, fix wallet fake-success, fix Detail pagination

## Type

bugfix

## Workstream

frontend

## Priority

high

## Created

2026-07-18

## Goal

A review of `admin/manage/player` (list, `edit/[id]`, `Detail/[id]`) found three
error-level defects that make an admin surface show fabricated data or claim a
money write succeeded when it did not. Fix those three; leave the accepted
placeholder sections alone.

## Scope

In (Games-Labs-backoffice, FE only):

**1. Mock fallback rendered as real data**
`mockPlayerDetail(id)` falls back to `mockPlayersList[0]` for any unmatched id
(`app/data/mock.ts:187`). Route ids are UUIDs, so the fallback is taken every
time, and every loader swallows its error into `console.error` — so a 401/500 or
a deleted user renders a complete, confident page for a different (fake) person.
- `Detail/[id].vue`: track identity load state; on failure render an explicit
  error state instead of placeholder identity; blank (not mock) the fields a
  failed loader owns.
- `Detail/[id].vue`: Purchase>Package must not fall back to
  `getPlayerHistoryTable('Purchase','Package')` on fetch throw — distinguish
  loading / empty / error.
- `edit/[id].vue`: the Security tab reset-password recipient and
  `SendVoucherPanel`'s `:email`/`:sms` must come from the real profile
  (`AdminUserApiItem.email` / `.phone`), rendering `—` when unknown — never from
  the mock player. This is a wrong-recipient-class defect on a credential action.

**2. Wallet PATCH fake success**
`edit/[id].vue:577-589` discards the response and always toasts
"Wallet updated successfully." Typed-proto gateway responses return HTTP 200
with the error in `body.status.code`, which is why the status and password
handlers on the same page call `assertEnvelopeOK`. Capture the response and
assert the envelope before the success toast.

**3. Detail pagination is wired to a non-existent event**
`Detail/[id].vue:734` and `:918` pass one-way `:current-page`/`:per-page` plus
`@go-page`, but `AdminDataTablePagination` exposes
`defineModel('currentPage')` / `defineModel('perPage')` and emits no `go-page`.
Both tables are stuck on page 1 while the footer reports "Showing 11 to 20".
Switch to `v-model:current-page` / `v-model:per-page` and delete the dead
`historyGoPage` / `gameGoPage` / `*PageNumbers` handlers.

Out:
- Any backend / proto / gateway change — FE only.
- Review findings 4 (mock Audit Log modal) and 5, and all warning-level items
  (absolute-set wallet write, request-generation guards, VIP turnover mock
  fallback, dead Search/DateRange controls, demo-only alerts, Export button,
  50-order cap). Separate runs.
- The accepted unbacked placeholder sections (Game tab, History Transaction
  Earned/Redeem/Send-coin, device info, coin aggregates) — unchanged, per
  [[preserve-ux-design-wire-data-only]].
- Redesigning any designed component — data source and state handling only.

## Verification

- `nuxt build` green.
- Pagination: Detail History/Game tables advance rows when the pager changes
  (page 2 shows rows 11-20, not rows 1-10).
- Mock fallback: with the gateway stubbed to fail, the Detail page shows an
  error state rather than "Frances Swann"; the edit page's reset-password
  recipient shows the real profile email or `—`.
- Wallet: a stubbed `{status:{code:400}}` envelope on the PATCH surfaces a
  failure toast, not "Wallet updated successfully."

## Depends on

None.

# TASK-EAR-129: Consolidate Provider Edit service-status toggle and add image upload

## Type

feature

## Workstream

frontend

## Priority

medium

## Created

2026-07-17

## Goal

On `admin/manage/provider/edit/[id]` (Games-Labs-backoffice), replace the two
separate "Production Status" and "Demo Status" toggles with a single
"Provider Status" toggle bound to the same `provider.status` field already
shown as the Active/Inactive badge on the provider list page. Add an image
upload control for the Provider Image card, replacing the current hardcoded
placeholder.

## Verified current defects

- `app/pages/admin/manage/provider/edit/[id].vue` splits one provider status
  concept into two toggles: Production Status (bound to `provider.status`)
  and Demo Status (bound to the `supportsDemo` capability flag). This is
  confusing because `supportsDemo` is a distinct capability already shown
  under Capabilities → "Demo: Yes/No" — it is not a second status.
- Provider Image (`imageUrl`) is hardcoded to `/provider1.png` in
  `useAdminProviderApi.ts`; there is no upload control on the page at all.
- No backend write endpoint exists yet for persisting provider status or
  image changes (`adminproviderhdl/grpc.go` only implements `ListProvider`,
  `GetProviderByID`, `ListGamesByProviderID` — all read-only). This task is
  frontend UI/UX only; interactions stay gated behind
  `canPersistProviderWrites` (currently `false`) with the existing
  confirm+toast "not wired yet" stub pattern.

## Approved implementation

1. Remove the separate Demo Status toggle from
   `admin/manage/provider/edit/[id].vue`; keep a single "Provider Status"
   toggle bound to `provider.status`, matching the Active/Inactive semantics
   used in `ProvidersListTable.vue`.
2. Add an upload control to the Provider Image card, wired to a stub handler
   consistent with the existing "not wired yet" toast pattern (no backend
   upload endpoint exists yet).
3. No backend or shared-lib changes; scope is Games-Labs-backoffice only.

## Acceptance criteria

- Provider Edit → Info tab shows exactly one service-status toggle labeled
  "Provider Status", reflecting `provider.status` (Active/Inactive), styled
  consistently with the existing toggle.
- Demo Status toggle and `demoEnabled` state are removed from the page.
- Provider Image card has a visible upload affordance; clicking it triggers
  the same confirm+toast "not wired yet" stub pattern as the other disabled
  writes (no silent no-op).
- Existing read-wired sections (Provider Info, Capabilities, Endpoints,
  Provider Games List) are untouched.
- `pnpm test` (or repo's existing test command) and production build still
  pass.

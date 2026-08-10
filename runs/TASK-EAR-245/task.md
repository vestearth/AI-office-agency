# TASK-EAR-245 — Redemption item Start/End Date + create Code-step residual

## Type

bugfix

## Workstream

frontend

## Priority

medium

## Created

2026-08-10

## Parent / Epic

- Epic: Admin Redemption Management
- Related: TASK-099 (edit date picker / field names; done), commit `610d39e` (`code is required` create path)

## Goal

QA reports that create/edit of redemption items (E-Voucher) leaves **Start Date / End Date** empty in the form even though Start Date is marked required. Also clean residual Code-step UX left after the `code is required` fix so create cannot proceed without a non-empty parsed `code[]`.

## Verified current state (2026-08-10)

- Create modal (`RedemptionItemCreateModal.vue`) uses `StoreSaleDatePicker` **without** `iso`, then `dmyToIso` — fragile; ISO values become `undefined` and are omitted from POST.
- Edit page already uses `iso` pickers, but **Update does not gate** on Start Date (or End Date when enabled).
- Backend Order does not require `start_date` on create/update (UI `*` only).
- `code is required` create bug fixed in `610d39e` (always send parsed `code[]`); residual: `codeValid` still allows `codeImportFile` alone, and UI copy still says demo / “API import after Create”.

## Scope

In:
- `Games-Labs-backoffice/app/components/RedemptionItemCreateModal.vue`
- `Games-Labs-backoffice/app/pages/admin/manage/redemption/items/edit/[id].vue`
- Focused source tests under `Games-Labs-backoffice/tests/`

Out:
- Backend Order proto/validation requiring `start_date` (optional follow-up)
- Gift-only product redesign
- Deploy/GitOps image pin

## Acceptance criteria

1. Create modal Start/End pickers use `iso` mode; create body sends ISO/RFC3339 `start_date` / `end_date` (no `dmyToIso`).
2. Create cannot submit (and Import File step invalid) unless `codes.length > 0` for E-Voucher; `codeImportFile` alone is not enough.
3. Code-step copy no longer claims “demo dropzone” or “API import after Create”.
4. Edit Update blocks with a clear toast when Start Date is empty; when End Date is enabled, End Date must also be set.
5. Focused tests cover the create/edit source contracts above.

## Assignment

- Primary: `dev`
- Parallel: false

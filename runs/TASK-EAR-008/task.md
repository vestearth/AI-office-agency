# TASK-EAR-008: Recover Orphaned Delete-Deactivate Drift in Store Exchange

## Short name
`store-exchange-orphan-drift-retry`

## Type
bugfix

## Priority
medium

## Parent / Epic
- Parent: `TASK-EAR-001`
- Epic: Admin Store Exchange Management
- Follow-up of: `TASK-EAR-007` review nit **N4 (delete-deactivate orphan drift)**

## Background

Store Exchange presets are Order packages mirrored into the Wallet rate catalog.
Delete runs Order `DeletePackage` (a HARD delete) first, then Wallet
`rate-catalog/{rate_key}/deactivate`. After a successful Order delete the row
disappears from the active list (`reload()`), so if the subsequent Wallet
deactivate FAILS, `onDeleteRow()` records the drift via
`markSyncError(row.codeName, ...)` but no row renders for that `codeName`
anymore. The drift lives orphaned in the `syncErrors` map with no UI affordance
to retry — the operator cannot recover the partial failure.

The existing per-row "Retry sync" affordance already covers create/update upsert
drift (the row still exists in those cases) and must keep working.

## Scope

### Target files
| File | Change |
| --- | --- |
| `app/composables/useAdminStoreExchangeApi.ts` | Export `deactivateWalletRate` so the page can retry the Wallet deactivate without re-issuing the (already-completed) Order delete. |
| `app/pages/admin/manage/store/exchange.vue` | Add an orphaned-drift banner above the table listing `syncErrors` entries with no matching row, each with a "Retry deactivate" button. |

### Approach (option a)
- Derive `orphanedDrift` as a computed from the existing `syncErrors` map:
  entries whose `codeName` has no row in `rows.value`. This is exactly the
  delete-deactivate case (create/update always leaves a row), so no parallel
  deleted-list state is introduced — `syncErrors` stays the single source of
  truth.
- `onRetryDeactivate(codeName)` calls `api.deactivateWalletRate(codeName)`;
  success clears the entry (`markSyncError(codeName, null)`), failure refreshes
  the recorded message. The banner re-renders reactively off `syncErrors`.

## Acceptance criteria
- A failed Wallet deactivate after a successful Order delete is visible in the
  UI and recoverable (retry succeeds → banner entry clears).
- Existing per-row "Retry sync" for create/update upsert drift is unchanged.
- `npx nuxi typecheck` stays no-worse-than-baseline: 18 pre-existing errors in
  unrelated files, 0 in the two target files.

## Provenance
Implemented via the Claude manual advisory lane acting in the `dev` role
(Claude is not a configured runner; see `ai-dev-office/docs/CLAUDE.md`). State
is set to `done` after independent reviewer approval.

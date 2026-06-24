# TASK-104: Wire Redemption Item Details And Conditions AI Translate UI

## Short name
`redemption-ai-translate-ui`

## Type
feature

## Priority
medium

## Parent / Epic
- Parent: `TASK-080`
- Epic: Admin Redemption Management

## Status

Assigned. Initial Codex implementation is already in the local
`Games-Labs-backoffice` working tree; keep this task open for review, follow-up
UI tweaks, and final summary once the user accepts the behavior.

## Background

The admin Redemption Item create/edit flows previously stored Details and
Conditions as a two-language shape (`th`/`en`). The backend contract already
supports `languages`, `details`, and `conditions`, and the User service exposes
the Backoffice translation endpoint through the gateway:

- `POST /admin/translate`
- supported language set: `th`, `en`, `zh`, `fr`, `es`

The requested UI shape is a source-language selector, Detail/Condition text
inputs, a Translate action, and language tabs (`TH`, `EN`, `CN`, `FR`, `ES`)
showing translated content.

## Goal

Make Redemption Item Create and Edit support the 5-language AI translate flow
for Details and Conditions without changing backend contracts or adding a new
frontend dependency.

## Scope

### Target Services

| Service | Reason |
| --- | --- |
| `Games-Labs-backoffice` | Create/Edit Redemption Item UI and payload wiring. |
| `ai-dev-office` | Task tracking and handoff artifacts. |

### Affected Files

| Path | Action | Description |
| --- | --- | --- |
| `Games-Labs-backoffice/app/components/RedemptionItemCreateModal.vue` | modify | Replace 2-language Details/Conditions state with 5-language maps, add Translate action, and save `languages/details/conditions`. |
| `Games-Labs-backoffice/app/pages/admin/manage/redemption/items/edit/[id].vue` | modify | Load, edit, translate, preview, and save 5-language Details/Conditions. |
| `ai-dev-office/runs/TASK-104/*` | create | PM task, status, and handoff artifacts. |

### Explicitly Excluded

- No backend/proto/shared-lib changes.
- No new endpoint.
- No new frontend dependency.
- No broad redesign of Redemption Item create/edit flows beyond the Details and
  Conditions section.

## Acceptance Criteria

- [ ] Create modal exposes language selector plus `TH/EN/CN/FR/ES` tabs for both
      Details and Conditions.
- [ ] Edit page exposes the same 5-language translate UI and preserves existing
      localized values when loading from API.
- [ ] Translate action calls `POST /admin/translate` with `source_lang` and
      `fields.detail` / `fields.condition`, then fills returned languages.
- [ ] Create submits `languages`, `details`, and `conditions` using lower-case
      language codes compatible with the backend contract.
- [ ] Edit submits the same 5-language payload shape while preserving the
      existing item update behavior.
- [ ] `npm run build` in `Games-Labs-backoffice` passes.
- [ ] Browser smoke is attempted against a local build/preview; if auth or local
      watcher limits block full UI smoke, document that limitation.

## Implementation Plan

1. Reuse the existing create modal and edit page instead of introducing a shared
   component first.
2. Define a local fixed language list matching the backend translate model:
   `th`, `en`, `zh`, `fr`, `es`; display `zh` as `CN` in the UI.
3. Store Details and Conditions as per-language maps in each existing file.
4. Add a small `translateContent` function in each file that calls
   `/admin/translate` and applies returned fields.
5. Build `languages`, `details`, and `conditions` from non-empty localized
   content at save time.
6. Verify with `npm run build`; use local preview for a smoke check when the
   local environment permits it.

## Risks

- The local preview route requires admin login before reaching the Redemption
  screens; browser smoke may stop at `/login` without a valid session.
- `npm run dev` may fail locally with `EMFILE: too many open files, watch`; use
  production preview from `.output` when this happens.
- Translate API requires a valid admin token and backend configuration; UI wiring
  can be build-verified locally, but real translation success needs a logged-in
  smoke test.

## Verification

- `cd Games-Labs-backoffice && npm run build`
- Optional manual smoke with real admin session:
  - Open Create E-Voucher/Gift.
  - Enter TH Detail/Condition.
  - Click Translate.
  - Confirm EN/CN/FR/ES tabs fill.
  - Save and reopen Edit.
  - Confirm localized values round-trip.

## Assignment

- Primary: `dev`
- Parallel: `false`

Reason: focused two-file frontend change with shared behavior; sequential edits
avoid divergent payload shapes.

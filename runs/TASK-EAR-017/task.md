# TASK-EAR-017: Fix Store Avatar Edit layout bug (footer overlaps content in edit mode)

## Short name
`store-avatar-edit-layout-fix`

## Type
bugfix

## Priority
medium

## Parent / Epic
- Epic: Backoffice Store management

## Status

Assigned. Bug confirmed via screenshot (edit mode) + code comparison. Claude-advisory
lane to fix, build-verify, summarize. This is phase 1 of the user's request; the
Description translate UI (mirroring TASK-EAR-015/016) is a separate follow-up.

## Background

`app/pages/admin/manage/store/avatar/edit/[id].vue` renders a flex column:
header (shrink-0) → scrollable body (flex-1) → sticky footer (shrink-0). In EDIT
mode the body shows extra rows (Final Price / Currency + Sale date pickers) that
are hidden in view mode. The screenshot shows the footer (Cancel / Update)
overlapping the date-picker row.

## Root Cause (investigation complete)

The scroll body is a `<fieldset>` used as the `min-h-0 flex-1 overflow-y-auto`
flex child (line 287). `<fieldset>` has special rendering that ignores
`min-height: 0` / flex-shrink (known Chromium behaviour), so it does NOT become a
constrained scroll area — it grows to its content's intrinsic height. In edit mode
the added rows push the content past the capped `max-h-[calc(100vh-8rem)]`
container, and the sticky footer overlaps the bottom rows.

Evidence: every working scroll body in the app (RedemptionItemCreateModal.vue:553,
VipLevelWizard.vue:1397, both user-accepted) uses a `<div>` for
`min-h-0 flex-1 overflow-y-auto`; none uses `<fieldset>`. The fieldset is the only
structural difference.

## Goal

Make the edit-mode body scroll correctly so the footer never overlaps content,
without losing the group-disable behaviour (`:disabled="isEditLocked"`).

## Scope

### Affected Files

| Path | Action | Description |
| --- | --- | --- |
| `Games-Labs-backoffice/app/pages/admin/manage/store/avatar/edit/[id].vue` | modify | Replace the fieldset scroll container with a div; keep a borderless `<fieldset :disabled>` inside for group-disable. Fix the "Infomation" label typo. |
| `ai-dev-office/runs/TASK-EAR-017/*` | create | PM task, status, handoff artifacts. |

### Explicitly Excluded

- No translate UI yet (separate follow-up task).
- No backend changes; page is still mock/demo.
- No changes to the Duration "0" placeholder behaviour (cosmetic, out of scope).

## Fix

1. Change the scroll container (line 287) from `<fieldset class="min-h-0 flex-1
   overflow-y-auto p-4 sm:p-5" :disabled="isEditLocked">` to
   `<div class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">`, and nest a
   `<fieldset class="m-0 min-w-0 border-0 p-0" :disabled="isEditLocked">` inside
   that wraps the two content cards (closing both at the former `</fieldset>`).
2. Fix the tab label: `{{ isEditLocked ? 'Infomation' : 'Info & Condition' }}` →
   `Info & Condition` (matches the Figma; removes the typo).

## Acceptance Criteria

- [x] In edit mode the body scrolls and the Cancel/Update footer never overlaps the
      Final Price / Currency / Sale date rows.
- [x] View mode is unchanged; group-disable still works (all inputs disabled when
      locked).
- [x] Tab label reads "Info & Condition" (no "Infomation" typo).
- [x] `npm run build` passes in `Games-Labs-backoffice`.

## Risks

- Browser smoke is login-gated, so visual confirmation of the scroll fix is the
  user's; build is the automated gate. Fix is reversible (structural wrapper only).

## Verification

- `cd Games-Labs-backoffice && npm run build`
- Manual: open Store Avatar edit → click Edit → confirm the date-picker rows scroll
  into view above the footer with no overlap; confirm inputs disable in view mode.

## Assignment

- Primary: `dev`
- Parallel: `false`

Reason: focused single-file layout fix with a confirmed root cause.

## Review closeout

Reviewer pass completed on 2026-06-29 against current `main`.

- Source reviewed: `Games-Labs-backoffice/app/pages/admin/manage/store/avatar/edit/[id].vue`.
- Verdict: approved; no blocking findings.
- Verification: `npm run build` passed in `Games-Labs-backoffice`.

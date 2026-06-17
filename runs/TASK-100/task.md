# TASK-100: Admin Store Exchange — image-file validation + non-negative number inputs

## Short name
`store-exchange-upload-and-number-validation`

## Type
bugfix + input hardening

## Priority
medium

## Parent / Epic
- Parent: Admin Store Exchange API integration (commit a638e2e, b41cb5f)
- Epic: Store admin management

## Status
In progress (Claude manual advisory lane).

## Background

Review of `app/pages/admin/manage/store/exchange.vue` (cross-checked by external
CLI agents and confirmed against the source) surfaced two input-validation gaps
that the sibling `store/packages/edit/[id].vue` already guards against:

1. **Thumbnail upload accepts any file type.** `onCreateThumbChange` /
   `onEditThumbChange` only checked `files?.[0]` existence — no
   `file.type.startsWith('image/')` guard, unlike `packages/edit` (L258). A
   non-image file could be previewed and uploaded to S3 on submit.
2. **Diamond / Coin steppers accept negative (and NaN) values.** The +/- buttons
   clamp with `Math.max(0, …)`, but the `type="number"` inputs let the user type
   negative values directly; submit only checked `> 0`.

Confirmed upload timing (no change needed, documented for the user): selecting a
file only builds a local `URL.createObjectURL` preview — the actual
`uploadImage(file, 'order-packages')` to S3 happens on Create/Update after the
confirm dialog, so cancelling never orphans an S3 object.

## Scope

- `app/pages/admin/manage/store/exchange.vue` only.
- Add `image/*` type guard (with `openAdminErrorToast` feedback) to both thumb
  change handlers.
- Clamp `createDiamond` / `createCoin` / `editDiamond` / `editCoin` to
  non-negative integers on input.

## Out of scope
Other review findings (i18n, focus-trap a11y, pagination clamp, slug uniqueness,
tests) — tracked separately if prioritized.

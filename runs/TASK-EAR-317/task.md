# TASK-EAR-317: Gift Create modal — Total Quota field is not typeable

## Short name
`gift-create-total-quota-input`

## Type
bugfix

## Priority
medium

## Parent / Related
- TASK-091 (persist Gift Total Quota — backend contract that made the manual
  Gift quota meaningful in the first place).
- TASK-089 / TASK-EAR-086 (Gift = manual Total Quota in Basic Info; E-Voucher =
  code-count, read-only).
- NOT related to `runs/TASK-112` (see Notes).

## Request

Tester reported: in the **Create New Gift** modal, the field
`Total Quota *` cannot be typed into — the value can only be changed with the
`−` / `+` buttons.

The operator recalls asking for this before; that earlier pass fixed the
**edit** page only and the create modal was missed.

## Root Cause

`Games-Labs-backoffice/app/components/RedemptionItemCreateModal.vue`, section
`QUOTA (Gift → Basic Info)`: the value between the `−` / `+` buttons was a
plain `<div>` rendering `form.totalQuota.toLocaleString('en-US')`, not an
input, so there was nothing to focus or type into.

The same control on the edit page
(`app/pages/admin/manage/redemption/items/edit/[id].vue`, `v-if="isGift"`) was
already converted to a real `<input>` by commit `9452112`; the create modal was
never brought along.

## Fix

Replace the display `<div>` with the same input pattern already used by the
edit page and by the `Limit per Day` control living a few lines below it in
this very modal:

```
<input :value="form.totalQuota" type="text" inputmode="numeric" aria-label="Total quota"
  class="min-w-0 flex-1 bg-transparent text-center text-sm font-semibold tabular-nums text-contrast-800 outline-none"
  @input="form.totalQuota = onIntInput($event)">
```

`onIntInput` strips non-digits and clamps at 0. The `−` / `+` buttons keep
their existing step of 1, and the existing `watch(totalQuota)` that caps
`limitPerDay` when the total drops still applies.

## Scope — deliberately NOT changed

- **E-Voucher** Total Quota stays read-only: it is `codes.length` derived from
  the imported code file (TASK-089 semantics).
- `edit/[id].vue:1388` still renders a `<div>`, but it sits under
  `v-if="!isEvoucher && !isGift"` and `TYPE_OPTIONS = ['E-Voucher', 'Gift']`,
  so it is unreachable dead code, not a tester-visible defect.

## Acceptance Criteria

- [x] Gift Create modal `Total Quota` accepts keyboard input.
- [x] Non-digit characters rejected, value clamped at >= 0.
- [x] `−` / `+` buttons unchanged; `limitPerDay` cap invariant preserved.
- [x] ESLint clean on the changed file; Vue SFC template compiles.
- [x] Visual confirmation in the running backoffice — click-through done, see
      Verification table.
- [x] Sign-off — operator merged PR 112 themselves (operator-final; the gh
      account authors these PRs so it cannot formally review them).

## Verification

- `npx eslint app/components/RedemptionItemCreateModal.vue` — exit 0, no findings.
- Vue `compileTemplate` on the SFC — 0 template errors.
- Nuxt dev server compiled the change with no error log.
- `git diff --stat` — 1 file, +3/-2.
- Click-through against a logged-in backoffice dev server (operator supplied
  the session; the Claude lane never entered credentials). Gift tab →
  Create New Gift → Basic Info:

  | Input | Result |
  | --- | --- |
  | type `2500` | field accepts it, renders `2500` |
  | type `12ab3` | `123` — non-digits rejected |
  | type `abc` | `0` — clamped, no NaN |
  | `−` from 3 | `2` — step button unaffected |
  | per-day `5`, then total → `3` | per-day auto-drops to `3` — cap invariant holds |

- Browser console carried no new errors. The two present are pre-existing and
  unrelated: a dev-mode hydration mismatch and an image-host `ERR_NAME_NOT_RESOLVED`.
- Shipped as `Games-Labs-backoffice` commit `a8e64b4` on branch
  `fix/TASK-EAR-317-gift-total-quota-input`, PR
  https://github.com/SparqLab/Games-Labs-backoffice/pull/112 (base `main`).
- Merged by the operator as `df25ac9` on 2026-09-04. Build and Deploy run
  33854322536 succeeded and the pipeline pinned the image to `sha-df25ac9`
  (`5378ecf`), so the fix is live on the deployed backoffice.

## Notes

- The edit-hook that fires on code changes under this workspace suggested
  "latest run TASK-112 → create TASK-113". That suggestion is wrong twice over:
  `runs/TASK-112` is an unrelated, already-`done` Wallet bugfix (ambiguous `id`
  in `getExistingExchange`, commit `462308a`, closed 2026-07-03), and the bare
  `TASK-NNN` namespace is superseded — runs are numbered per target project as
  `TASK-<PREFIX>-NNN`. Backoffice work belongs to the `EAR` sequence, whose
  highest run was TASK-EAR-316, hence TASK-EAR-317.

## Assignment

- Primary: Claude advisory lane (recorded as `free-roam` for enum compliance)
- Parallel: `false`

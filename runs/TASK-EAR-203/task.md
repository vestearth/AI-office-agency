# TASK-EAR-203 — Wire the Game edit page's fake save actions to the admin API

## Request

`Games-Labs-backoffice/app/pages/admin/games/edit/[id].vue` has save actions
that only mutate local component state and show a toast — nothing reaches the
backend. Wire them to the existing admin API. Sweep the same page for any other
no-op handler before closing.

## Origin

Found while verifying TASK-EAR-199 (VIP-level game status) on staging. QA tried
to flip a game's Production Status to `inactive` from this page to test the
non-active-member behavior and the toggle did nothing observable — the operator
had to update the row directly in the database instead. That is the finding:
ops has no way to change a game's status from the UI at all, which is exactly
the lever TASK-EAR-199 assumed staff could pull.

## Source evidence

Two confirmed no-op handlers, both literally labeled `(demo)` in the toast text
— not a guess, grepped directly:

- `onToggleProduction` (`[id].vue:346`) — sets `productionEnabled.value` (a
  local ref) and shows `Production ${...} (demo)`. No request is sent. A page
  reload reverts it. This is the **Production Status** toggle at `[id].vue:470`,
  the one QA used.
- `onPrimaryAction` (`[id].vue:329`) — the page's single Edit/Save button.  On
  save it shows `'VIP Level updated (demo)'` (`[id].vue:342`) and flips
  `isEditing` back to `false`. No request is sent here either. The only field
  this handler's fieldset actually lets the user change is **VIP Level**
  (`form.vipLevel`, bound at `[id].vue:617`) — `RTP%` in the same section is
  `readonly` regardless of edit mode (`[id].vue:626`), so it is not a save
  target despite sitting inside the same form.

## Backend is already there — no proto or service change needed

- `UpdateGameRequest` already carries `status = 8` and `level = 12`
  (`shared-lib/proto/admin/admingamepb/admingame.proto:478-491`).
- `Games-Labs-Game`'s `UpdateGame` handler already reads and normalizes both:
  `internal/core/handlers/admingamehdl/grpc.go:574` (`normalizeStatus`) handles
  status; `level` is accepted as `int64` (`VIP Level` maps to `games.level` —
  confirm the existing mapping between `form.vipLevel` strings like `"VIP5"` and
  the numeric `level` field before wiring, since the picker/list surfaces
  elsewhere in Backoffice already do this conversion and should be reused rather
  than re-derived).
- The existing update composable/API call used elsewhere in this app for game
  edits should be reused if one already exists for this route; check
  `app/composables/` before writing a new fetch call.

## Secondary observations (confirm scope before including)

Found while reading the surrounding code; not confirmed broken, just suspicious
enough to rule in or out explicitly rather than silently leaving alone:

- `VIP_OPTIONS` (`[id].vue`, near the `form` declaration) only lists `VIP1`
  through `VIP8`. The Level Groups list elsewhere in Backoffice shows levels up
  to at least `VIP22`. If the VIP Level field is wired up, this truncated list
  needs to be reconciled with the actual level catalog or games above VIP8
  cannot be reassigned from this page.
- The `Bet Limit` tab's `betMin`/`betMax` selects are hardcoded
  `disabled` (`[id].vue:741`, `:747`) with no visible toggle path in this file —
  unclear whether that is intentionally out of scope for this page or another
  dead control. Confirm with source/product before deciding whether it belongs
  in this run.

## Goal

From this page, staff can toggle a game's Production Status (active/inactive)
and change its VIP Level, and the change is real: it persists through the
existing `UpdateGame` RPC, survives a reload, and is reflected everywhere else
that reads `games.status` / `games.level` — including the TASK-EAR-199 filter,
which depends on staff being able to do this without touching the database.

## Scope

- Included: `Games-Labs-backoffice` — wire `onToggleProduction` and the
  VIP-Level portion of `onPrimaryAction` to the admin `UpdateGame` API; a full
  sweep of this one file for any other `(demo)`-labeled or otherwise-fake save
  path; focused tests.
- Excluded: proto/backend changes (not needed — see above), the Bet Limit tab
  unless scope review includes it, any other admin/games page not covered by
  this file, production deployment.

## Constraints

- Preserve the existing confirm-dialog UX (`openAdminSaveConfirm`) and toast
  pattern (`openAdminSaveToast`) — replace only the fake success message with a
  real one reporting the actual API result, including a failure path (the
  current code has none to replace, since nothing can fail today).
- Do not touch fields that are `readonly` today (e.g. `RTP%`) unless a separate
  decision is made to make them editable — that is out of scope here.
- Follow `preserve-ux-design-wire-data-only`: the toggle and Edit/Save button
  are design-approved; wire data into the existing controls, don't redesign
  them.

## Acceptance criteria

1. Toggling Production Status calls the admin update API with the new status
   and reflects the confirmed value after a page reload.
2. Editing VIP Level and saving calls the admin update API with the new level
   and reflects the confirmed value after a page reload.
3. Both actions surface a real failure (e.g. network/validation error) instead
   of always showing a success toast.
4. A game deactivated through this page is excluded from the TASK-EAR-199
   player-facing VIP games filter and still visible to staff — closing the loop
   QA had to work around by editing the database directly.
5. No other fake/no-op save handler remains on this file, or any found are
   explicitly listed as out of scope with a reason.
6. Focused tests cover the wired handlers; existing suite and production build
   stay green.

## Suggested ownership

Single-file Backoffice change with an existing backend contract — sequential,
no special review escalation needed beyond the usual pass.

# TASK-EAR-068: Default event create window to today → end of month

## Short name

`event-create-window-default`

## Type

enhancement

## Workstream

frontend (Games-Labs-backoffice)

## Created

2026-07-03

## Goal

On `admin/manage/missions/event/create`, set sensible schedule DEFAULTS on open (both fields remain editable):

- Start Date: defaults to the current date.
- End Date: defaults to the last day of the current month.

Requested by operator 2026-07-03 as a refinement of TASK-EAR-067. (An earlier
pass locked the fields read-only; operator clarified they wanted defaults only,
so the lock was removed and both inputs stay editable.)

## Change (frontend only, `create.vue`)

- `startDate` = today; `endDate` = last day of the current month
  (`new Date(y, month+1, 0)` = day 0 of next month = last day of this month),
  computed from local/Bangkok date parts.
- Both `type="date"` inputs stay editable (no lock); the operator can adjust
  either date after opening the form.
- Times (Start/End Time) remain editable; existing datetime validation
  (`endAfterStart` compares full RFC3339 instants) unchanged.

## Edge cases (verified)

- December → next-month rollover, February (28) and leap-year February (29):
  correct last day computed.
- Created on the last day of the month → start date == end date; the event is a
  same-day window, still valid because End Time (18:00) > Start Time (09:00).
  Editing End Time to <= Start Time on that day correctly blocks submit.

## Verification

- `npx nuxi typecheck`: zero errors in create.vue (baseline unaffected).
- Logic verified directly across month/leap/rollover cases.
- Browser smoke not run (create page behind admin auth on a live backend);
  change is a deterministic default + a standard disabled-input.

## Scope / branch

Stacked on `fix/TASK-EAR-067-event-create-defaults` (TASK-EAR-067 not yet
pushed/merged) so the operator's single push + PR to `main` carries both the
EAR-067 default fixes and this window lock. Frontend only; no backend/contract
change. Edit page unaffected (fills dates from the saved event).

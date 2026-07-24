# TASK-EAR-154: Disable "Permanent" duration option on Store Pass items

## Type

frontend

## Workstream

backoffice

## Priority

medium

## Created

2026-07-24

## Goal

On `admin/manage/store/items?tab=pass`, the Duration field offers two radio
options: "Permanent" and "Day". Operator wants "Permanent" disabled (not
selectable) for now, in both the Create Pass flow and the Edit Pass page.

## Scope (Games-Labs-backoffice)

Two independent implementations (no shared component) each need the same
change:

1. `app/pages/admin/manage/store/items.vue` — Create Pass modal, step 2,
   `createPassDurationType` radio (`value="Permanent"`, ~line 1692). Default
   ref is `ref<'Permanent' | 'Day'>('Permanent')` (~line 123) — must change
   default to `'Day'` since Permanent can no longer be selected on create.
2. `app/pages/admin/manage/store/pass/edit/[id].vue` — Edit Pass page,
   `durationType` radio (`value="Permanent"`, ~line 606). On load,
   `durationType.value = item.isPermanent ? 'Permanent' : 'Day'` (~line 449)
   — leave this untouched (don't mutate existing item data), just disable
   the radio input so it can't be newly selected.

Do not touch the unrelated third "Permanent" radio in `items.vue` (~line
1428, `createDurationType`) — that belongs to the Avatar item's Condition
step, not Pass.

## Non-goals

- No backend/API change — `isPermanent` field and payload shape stay as is.
- No redesign of the Duration control (per house rule: wire/adjust data
  only, don't replace designed components).

# TASK-EAR-156 — Store items: swap Pass Duration toggle to Day-only

## Context
On `admin/manage/store/items`, the Duration Permanent/Day toggle for **Limited Avatar**
(Create + Edit) is locked to **Permanent** (Day radio disabled). Operator confirmed that
is correct for Avatar.

For **Pass**, the toggle must be the opposite: locked to **Day** (Permanent radio disabled,
Day radio + stepper enabled, default = Day).

## Scope (Backoffice FE, data/behavior only — no redesign)
- `app/pages/admin/manage/store/items.vue` — Pass Create modal (`createPassDurationType`)
- `app/pages/admin/manage/store/pass/edit/[id].vue` — Pass Edit page (`durationType`)

## Change
- Permanent radio → `disabled` + label `opacity-50`
- Day radio → enabled + label full opacity
- Default ref value `'Permanent'` → `'Day'` (create ref, create reset, edit ref)
- Avatar Create/Edit untouched.

## Verify
- Operator visual check: Pass Create step 2 + Pass Edit show Day active, Permanent greyed/locked.

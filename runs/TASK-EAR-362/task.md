# TASK-EAR-362 — VIP level edit form shows default conversion for unconfigured levels

## Type

frontend bug (misleading admin state), Games-Labs-backoffice

## Parent / discovery

- Found during TASK-EAR-361 staging verification, 2026-09-16.
- Staging level 2 had no `privileges.turnover` (public `GET /api/v1/vip-levels/2`
  returned `points: "0"` and no `turnover`), but the backoffice edit page
  (`/admin/manage/vip/edit/2` → Privileges → Point) displayed
  **Turn Over 10,000 → Point 1**. Staging gateway logs had no
  `PUT /api/v1/admin/levels/2` until an operator-approved save. The operator
  reasonably read the form as "already configured".

## Root cause (source, `app/components/VipLevelWizard.vue`)

- `resetFromProps` edit branch (~line 721):
  `pointTurnover.value = Number(turnover.turnoverRequired ?? 10_000)` and
  `pointEarn.value = Number(turnover.point ?? 1)` — when `previleges.turnover`
  is absent, the form silently shows create-time defaults.
- Refs initialise to `ref(10_000)` / `ref(1)` (~line 130).
- `previlegesForApi()` always emits a `turnover` object, and
  `buildEditPrivileges` merges it only when saving from the Point tab, so the
  defaults are persisted only if an admin presses Update on that tab.

## Goal

In **edit mode**, an admin must be able to tell whether a level's turnover
conversion is configured, and must not be shown values that are not stored.

## Scope

- Edit mode, Privileges → Point tab: when `previleges.turnover` is absent,
  render a clear not-configured state (e.g. empty inputs with placeholder and
  a "Not configured" hint) instead of 10,000 / 1.
- Pressing Update from that tab must require explicit values; it must not
  save the old implicit defaults without the admin entering them.
- A level that has `turnover` stored keeps showing its stored values
  (including a stored `0`, which must not be treated as absent).
- Create mode may keep its 10,000 / 1 starting values (unchanged behaviour),
  unless the dev finds this also persists silently — report it, do not
  expand scope.
- **Preserve the approved design** (layout, cards, +/- steppers); change only
  the empty-state values and hint. See knowledge note "Preserve UX design,
  wire data only".

## Sibling check (report only)

- Reward tab: `rewardName` falls back to `Reward ${levelName}` when no reward
  is stored. Toggles default off, so it is less misleading, but confirm whether
  saving from the Reward tab can persist an unconfigured reward the admin did
  not intend. Report findings in the dev output; fix only if trivially the same
  pattern and the operator agrees.

## Acceptance criteria

- Unit/component test: edit mode with `previleges.turnover` absent → Point
  inputs are empty / not-configured, not 10,000 / 1; test seen failing before
  the fix (test-integrity rule).
- Test: stored `{turnoverRequired: 5000, point: 0}` renders 5,000 / 0.
- Test: Update from the Point tab with empty values is blocked (validation),
  and with entered values sends exactly those values.
- `npm` lint/typecheck/test and production build pass.
- Authenticated browser smoke on a local prod-build preview (per the
  backoffice smoke recipe) against staging data: a level without turnover
  (e.g. level 3 as of 2026-09-16) shows not-configured; levels 1/2 show
  10,000 / 1. **Do not press Update in smoke against staging** unless the
  operator approves.

## Out of scope

- Backend / proto / gateway changes, other VIP tabs' layout, create-mode
  defaults, production deploy, the Android client repo.

## Deploy / rollback

Frontend only. Backoffice `main` deploys to `admin-dev.gameslabs.app`
(staging data). Rollback = revert the commit / previous image pin.

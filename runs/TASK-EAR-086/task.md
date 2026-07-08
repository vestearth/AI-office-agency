# TASK-EAR-086: Redemption item edit Setting quota semantics and Used/Total display

## Short Name

`backoffice-redemption-item-edit-setting`

## Type

bugfix

## Priority

high

## Parent / Epic

- Parent: `TASK-099`
- Epic: Redemption admin management

## Status

Opened 2026-07-08 from QA/product review of
`admin/manage/redemption/items/edit/[id]` against the Figma Setting behavior.

## Background

After investigating a QA `redemption item quota exceeded` report, we confirmed
the runtime item quota is not the same as the Setting page's daily/player quota
controls:

- E-Voucher total item quota is code-derived (`total_quota` from
  `redemption_item_codes`).
- Redeem fails when `total_quota > 0 && total_redeemed >= total_quota`.
- The Setting tab's existing `10` values are daily/player quota controls, not
  total item quota.

The current Edit page still leaves the operator-facing quota semantics confusing.
The Figma review shows the Setting tab should make the split explicit:

- Show `Used/Total Quota` in edit mode, next to the quota controls.
- `Enable Quota limit per Day` controls E-Voucher per-day quota.
- `Player Quota Conditions` and `Limit per Player` / `Limit Day per Player`
  control user-level E-Voucher claim rules.

Source evidence already found:

- `Games-Labs-backoffice/app/pages/admin/manage/redemption/items/edit/[id].vue`
  has a hardcoded read-only summary quota value `999/10,000`.
- The edit page already reads `totalQuota`; it must also read/display the correct
  used counter from the API response.
- `Games-Labs-Order` exposes `quota_used`, `total_quota`, and `total_redeemed`
  on redemption item responses.

## Scope

| Area | Action |
| --- | --- |
| `Games-Labs-backoffice/app/pages/admin/manage/redemption/items/edit/[id].vue` | Update the Setting tab UI/behavior for E-Voucher quota semantics and show Used/Total Quota in edit mode. |
| `Games-Labs-backoffice/app/components/RedemptionItemCreateModal.vue` | Keep create/edit quota label behavior aligned if the shared quota controls live in both places. |
| `Games-Labs-Order` / `shared-lib` | Source verification only unless dev confirms a backend contract gap. Do not change proto/service contracts in this task without escalating first. |
| `ai-dev-office` | Track PM scope, implementation evidence, and verification. |

## Product Contract

1. **Used/Total Quota**
   - Display on the E-Voucher edit Setting tab.
   - Use current backend response fields, not hardcoded values.
   - Total should match the code-derived E-Voucher total quota.
   - Used should follow the code/source contract after verification
     (`total_redeemed` or `quota_used`; if both are equivalent today, document the
     chosen field in code comments or task evidence).

2. **Enable Quota limit per Day**
   - This is the E-Voucher per-day quota control.
   - Keep it visually and semantically separate from total item quota and
     user-level claim limits.

3. **Player Quota Conditions**
   - `Unlimited redemptions`: no user-level quota; lock/disable the limit input
     and show `-`.
   - `Limited to one claim per day per player`: user can claim once per day;
     label the numeric control as `Limit Day per Player` or split it clearly if
     product/design chooses a separate input.
   - `One-time use only`: user can claim once total; force the limit input to `1`
     and lock it.

4. **E-Voucher user controls**
   - `Player Quota Conditions` plus the limit input control user-level E-Voucher
     claim behavior.
   - The UI must not imply these values increase total item quota.

## Acceptance Criteria

- [ ] E-Voucher edit Setting tab shows `Used/Total Quota: X/Y` using real API
      data; no `999/10,000` hardcode remains.
- [ ] E-Voucher total quota displayed on edit matches the backend code-derived
      quota and does not come from the daily/player quota controls.
- [ ] Selecting `Unlimited redemptions` locks the limit input and displays `-`.
- [ ] Selecting `Limited to one claim per day per player` uses wording
      `Limit Day per Player` or an explicitly separated equivalent control.
- [ ] Selecting `One-time use only` forces the limit value to `1`, locks the
      input, and saves the correct player quota condition.
- [ ] `Enable Quota limit per Day` remains a per-day E-Voucher quota control and
      is not conflated with total item quota.
- [ ] Create and edit flows use consistent labels/mapping where they share these
      controls.
- [ ] If source review shows the backend does not enforce one or more user-level
      quota rules, dev records the gap and opens/requests a backend follow-up
      instead of shipping misleading UI-only behavior.
- [ ] `nuxi typecheck` is no worse than current main for touched frontend files.
- [ ] Browser/operator smoke: load an E-Voucher item, switch each player quota
      condition, verify locking/default values, Update, reload, and confirm saved
      state plus Used/Total display.
- [ ] `ruby ai-dev-office/validate-yaml.rb TASK-EAR-086` passes.

## Out Of Scope

- Reworking Gift quota behavior unless shared components make a small label
  alignment unavoidable.
- Changing redemption runtime enforcement, proto contracts, or migrations without
  a separate backend-scoped task.
- Pixel-perfect work outside the Setting quota area shown in the supplied Figma
  screenshots.

## Assignment

- Primary: `dev`
- Parallel: `false`

Reason: this is concentrated in the Backoffice edit page and shared create/edit
quota controls. Start with source verification, then implement the smallest
frontend change. Escalate to backend only if the live contract cannot support
the requested behavior.

## Verification Plan

- Source check: confirm the edit API response fields for `quotaUsed`,
  `totalQuota`, and `totalRedeemed`; choose the correct `Used` source.
- Frontend check: remove hardcoded quota display and verify the Setting tab shows
  real values.
- State check: verify player quota condition selection drives labels, default
  values, locking, and update payload.
- Command check: run frontend typecheck for `Games-Labs-backoffice` and
  `ruby ai-dev-office/validate-yaml.rb TASK-EAR-086`.

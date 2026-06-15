# TASK-099: Redemption item Edit — fields don't persist (Start Date, Limit claims per day, Player Quota Condition) + Limit per player non-interactive

## Short name
`redemption-item-edit-field-persistence`

## Type
bugfix + UI alignment

## Priority
high

## Parent / Epic
- Parent: TASK-081 (UpdateRedemptionItem wiring), TASK-098 (POST→PUT)
- Epic: Redemption admin management

## Status
In progress. Root cause confirmed against proto + gateway marshaler.

## Background

After TASK-098 fixed the 405 (POST→PUT), the user reports that several fields on
`admin/manage/redemption/items/edit/[id]` still don't save:
- **Start Date** — value doesn't persist; input is a plain text box, not a date picker.
- **Limit claims per day** — edits don't save.
- **Limit per player** — fully non-interactive (disabled), can't change anything.

User direction: the create flow was redesigned (RedemptionItemCreateModal for
E-Voucher/Gift); the Edit page should be aligned to that UI. User will provide
the exact UI spec if a pixel-perfect match is needed.

## Root cause

The backend contract (proto `UpdateRedemptionItemRequest` / `orderpb.RedemptionItem`)
uses these JSON field names (lowerCamelCase via protojson):
`startDate`, `endDate`, `isEndDate`, `isQuotaLimitPerDay`,
`playerQuotaCondition` (string), `limitDayPerPlayer` (int64). There is **no**
`limit_per_player` field — exactly one numeric quota field exists.

The backoffice was wired with **wrong field names**:
- Edit save/read used `playerQuotaCondition1` and `limitDayPerPlayer1` (a `1`
  suffix that is not in the contract).
- Create modal used `player_quota_condition_1` and `limit_day_per_player_1`
  (same `_1` suffix bug, snake_case).

The api-gateway uses grpc-gateway's default marshaler
(`runtime.NewServeMux` with no custom JSONPb), whose `UnmarshalOptions` has
`DiscardUnknown: true`. So those mis-named fields were **silently discarded** on
both create and update — the values never reached the DB. No 400 was raised,
which is why the bug was invisible.

Start Date had a second issue: the Edit input is `type="text"` requiring an
exact `dd/MM/yyyy HH:mm:ss` string; `dmyToIso()` returns `undefined` for any
other format, dropping the field. The create modal already uses
`StoreSaleDatePicker`.

## Field mapping decision (per user)

One backend numeric field (`limit_day_per_player`) + the `is_quota_limit_per_day`
toggle. Mapping aligned to the create modal:
- "Limit claims per day" → `limitDayPerPlayer` (PERSISTED).
- "Limit per player" → interactive UI only, **not persisted** (matches the create
  modal, which also never sends it). Real persistence needs a new backend field
  (deferred, cross-service).

## Affected files

| File | Change |
| --- | --- |
| `Games-Labs-backoffice/app/pages/admin/manage/redemption/items/edit/[id].vue` | Date pickers (Start/End via StoreSaleDatePicker iso); store/send ISO; fix `playerQuotaCondition`/`limitDayPerPlayer` field names (read+write); make Limit per player interactive |
| `Games-Labs-backoffice/app/components/RedemptionItemCreateModal.vue` | Fix `player_quota_condition`/`limit_day_per_player` field names (drop the `_1` suffix) so create persists them |

## Acceptance criteria

- [ ] Start Date / End Date use a date picker on Edit and persist on Update.
- [ ] "Limit claims per day" persists on Update and reloads correctly.
- [ ] "Player Quota Conditions" persists on Update and reloads correctly.
- [ ] "Limit per player" is interactive in edit mode (consistent with create).
- [ ] Create modal persists player quota condition + daily limit (field-name fix).
- [ ] `nuxi typecheck` no worse than main on touched files.
- [ ] Operator smoke: edit each field → Update → reload shows the saved values.
- [ ] `validate-yaml.rb TASK-099` passes.

## Out of scope

- Adding a real backend field for "Limit per player" (new proto field + Order
  migration/handler + redeploy) — deferred unless the user opts in.
- Pixel-perfect restyle of the Edit quota section to the new create design —
  pending the user's UI spec; this task does the functional alignment.

## Assignment

- Primary: `dev`
- Parallel: `false`

Scoped via the Claude manual advisory lane (not a configured runner).

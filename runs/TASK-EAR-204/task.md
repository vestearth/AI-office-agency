# TASK-EAR-204 — Mission display name must follow the live plan, not the current template

## Request

A generated mission's display name and its progress target come from two
different sources in `Games-Labs-Missions`. The name is resolved from the
*current* default template; the progress bar comes from the *already generated*
plan row. Editing a default template after a plan has been generated makes the
two disagree. Make the name follow the plan the player is actually playing.

## Origin

Operator-reported from a live staging comparison, Daily tab, 2026-08-04:

| Surface | Value |
| --- | --- |
| Admin `Min Spending Value` (current template) | 10 |
| App progress bar | `10/400` |
| App mission title | `Spend 10 Diamonds` |

The player sees a mission titled "Spend 10 Diamonds" whose bar requires 400.
Backoffice's own Daily plan row for the same day correctly reads
`Spend 400 Diamonds with Randomly by System / 400 Diamond`, so this is a
mobile-facing naming defect only — the plan data itself is right.

## Not a bug — explicitly ruled out

`RegenerateDailyDue` deliberately never rewrites *today*; it regenerates
tomorrow onward. That invariant is locked by
`internal/services/schedule_regenerate_test.go:18`
(`TestRegenerateDailyDue_SkipsManual_DeletesEmptiedSchedule_NeverTouchesToday`,
TASK-EAR-079). Today's plan legitimately keeps the threshold it was generated
with. Nothing in this run may change that behavior — the fix is on the display
side.

## Source evidence

`missionDisplayNameValuesFromTemplate`
(`internal/services/mission_display_name.go:85`) seeds every value from the
current template. Call sites then use the live plan value only as a fallback
when the template value is empty:

- `internal/services/quest_overview_service.go:400` — `values.spendingDiamonds
  <= 0` → `activity.Threshold`. Template `10` is non-zero, so the live `400`
  never applies. This is the exact reported symptom.
- `internal/services/quest_overview_service.go:397` — same inverted precedence
  for `category` vs `activity.GameType`.
- `internal/services/quest_overview_service.go:310,313` — same pair on the
  daily *group* parent name.
- `internal/services/quest_overview_service.go:489` — same for weekly
  (`mission.Target`).
- `internal/services/weekly_service.go:560,564` — same for the weekly card
  title.

The inconsistency is internal to these same functions: `totalGame` already does
the opposite and lets the plan win unconditionally —
`quest_overview_service.go:318` (`values.totalGame = gr.TargetChildren`),
`:394-396`, and `weekly_service.go:558` (`definition.PoolSize`). Game-count
missions therefore never show this mismatch; only `category` and
`spendingDiamonds` do.

## Goal

For a schedule-generated mission, the name is derived from the plan row the
player is progressing against, so title and progress bar can never disagree.
The template supplies the name *pattern* and remains the fallback for values the
plan does not carry.

## Scope

- Included: `Games-Labs-Missions` display-name resolution — invert the
  precedence for `category` and `spendingDiamonds` at all five call sites above
  (daily item, daily group parent, weekly tab, weekly card), plus regression
  tests.
- Excluded: schedule generation and `RegenerateDailyDue` semantics (see above);
  Backoffice; any proto or DB change; the `totalGame` paths, which are already
  correct.

## Constraints

- Additive to the API contract: `display_name` stays optional/omittable; no
  field added or removed.
- Template stays the fallback — a plan row with `Threshold = 0` or an empty
  `GameType` must still render the template's value, not a literal `0`/empty.
- Regression test must be seen failing before the fix
  (`ai-skills/rules/test-integrity`).

## Acceptance criteria

1. Template `minSpendingValue = 10` + plan `Threshold = 400` renders
   `Spend 400 Diamonds` — the reported case, covered by a test that fails
   before the change.
2. Same precedence holds on the daily group parent name and on both weekly
   surfaces.
3. Plan `Threshold = 0` still falls back to the template value.
4. Category behaves the same way: live `GameType` wins, template is fallback.
5. `totalGame` behavior is unchanged.
6. Full `Games-Labs-Missions` test suite green; no schedule-generation test
   modified.

## Suggested ownership

Single-service, single-concern change with existing test coverage nearby —
sequential, no review escalation beyond the usual pass.

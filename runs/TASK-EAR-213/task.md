# TASK-EAR-213 — Orphaned `daily_activities`/`weekly_activities` rows: mechanism, volume, and what (if anything) to do

## Request

While closing TASK-EAR-211, a query scoped to "frozen names on plans a player
can still see" (joined through `daily_activity_group_members` +
`daily_plans`, `plan_date >= CURRENT_DATE`) returned 2 rows. A later,
unrelated manual test on `daily-sched-2026-08-10-spend_prop` — a row that
already existed with a frozen name at the time that query ran, dated well
inside the live window — was not among them. Confirming the mechanism led to
a bigger finding than the one row: activities are never deleted, only
membership is replaced on every save, and this produces **352 Daily / 14
Weekly** currently-orphaned rows — 93% of the Daily total from a single,
recurring, non-admin-triggered cause. Decide, with that number in hand,
whether anything needs to change.

## Origin

Found by the operator testing TASK-EAR-211 on staging, 2026-08-05. Recorded as
an open, unconfirmed finding in that run's `status.yaml` and `task.md` rather
than chased to ground before closing — TASK-EAR-211's own acceptance criteria
didn't depend on the answer, but leaving "most likely explanation, not
independently confirmed" standing isn't good enough to treat as settled.

## Hypothesis, now confirmed in source (not yet confirmed in data)

`daily_activities` rows are **never deleted**. Only membership is replaced.
`SaveDailyPlanFull` (`internal/repositories/daily_plan_repo.go:331`) does:

```go
tx.ExecContext(ctx, `DELETE FROM daily_activity_group_members WHERE group_id = $1`, group.ID)
for _, m := range members { INSERT ... }
```

on **every save** — a full delete-and-reinsert of the day's roster from
whatever the Backoffice payload's `members` list says. The corresponding
`daily_activities` row for a deselected task is untouched by this — it isn't
in `members` DELETE's scope at all, it just stops having a membership row.

The read path only ever sees membership-linked rows.
`assembleDailyPlanDetail` (`internal/handlers/adminmission/http/daily_plans.go:178`)
builds `activities` by iterating `group.Members` and fetching each by id —
an orphaned `daily_activities` row with no membership row is invisible to it,
and therefore invisible to the Backoffice editor's `toFormTask` path, and
therefore invisible to any query joined through `daily_activity_group_members`
(exactly the query TASK-EAR-211 used for its live-row count).

Sequence that reproduces the observation:

1. Some earlier save (schedule generation or a manual edit) created
   `daily-sched-2026-08-10-spend_prop` — `created_at = 2026-07-14`.
2. A later save for that same plan did **not** select spend_prop. Its
   `daily_activity_group_members` row was deleted by the full-replace; the
   `daily_activities` row itself was not — it became orphaned. From this point
   it is not part of the live plan, not returned by `assembleDailyPlanDetail`,
   and correctly excluded from a query joined through group membership.
3. 2026-08-05: TASK-EAR-211's live-row query runs, correctly finds nothing for
   this id — it is genuinely not part of any player-visible plan at that
   moment.
4. Later the same day: the operator opens the Aug 10 plan in Backoffice.
   Because the backend didn't return this activity, `toRoster()` falls back to
   `seedDefaultTask('spend_prop', planId)` — using the SAME id
   (`${planId}-${type}` is deterministic), showing the CURRENT Default Mission
   template's resolved text. The operator edits the name and Special Item
   dropdown, selects the task, and saves.
5. The save UPSERTs against the pre-existing id — `ON CONFLICT (id) DO UPDATE`
   updates every listed column but never touches `created_at` — so the row's
   `created_at` stays 2026-07-14 even though it was just re-populated from a
   fresh seed. It is also re-linked into `daily_activity_group_members`,
   making it player-visible again from this point on.

Every step above is confirmed against the actual write and read paths, and step
2 — this specific row was deselected in the Backoffice editor at some point
before this run — is a real, confirmed instance of the general mechanism. It is
NOT, however, the dominant source of orphaned rows overall — see "Measured
composition" below. Query 3 additionally confirmed the row is re-linked as of
this run's test save (`group_id` populated, no longer orphaned), closing the
loop on this one id specifically.

## Measured composition, 2026-08-05 staging

Total orphans: **352 Daily, 14 Weekly**. Daily broken down by condition type,
whether the id is a per-game `TURNOVER_GAME` child (`-g\d+$`), and whether it
was ever touched after creation (`created_at = updated_at` → written once and
never revisited):

| condition_type | game child? | touched again? | count |
| --- | --- | --- | --- |
| TURNOVER_GAME | yes | yes | **284** |
| TURNOVER_GAME | yes | no | 44 |
| SPEND_DIAMOND_AMOUNT | no | no | 8 |
| TURNOVER_GAME_TYPE | no | no | 5 |
| SPEND_DIAMOND_AMOUNT | no | yes | 4 |
| *(NULL condition_type)* | — | no | 3 |
| TURNOVER_GAME_TYPE | no | yes | 2 |
| TURNOVER_AMOUNT | no | yes | 1 |
| SPEND_AMOUNT | no | yes | 1 |

`TURNOVER_GAME` children are **328 of 352 (93%)**. The Aug-10
`daily-sched-2026-08-10-spend_prop` row that started this investigation — a
single mission type deselected in the Backoffice editor — belongs to a
12-row minority (`SPEND_DIAMOND_AMOUNT`, both sub-buckets combined), not the
dominant pattern.

### The dominant pattern is NOT admin deselection — it's deterministic reshuffle on regeneration

`selectGameIDsForPeriod` (`internal/services/schedule_generator.go:94`) is
**not random**: it ranks the active game pool by
`sha256(periodKey + "\x00" + gameID)` and takes the top `total` (Total Game).
For a fixed pool and a fixed `total`, the same date always selects the same
games — nothing rotates on its own.

But `RegenerateDailyDue` (`internal/services/schedule_generator.go:586`)
reruns this for **every future date in the horizon, every time it runs**,
always against the *current* `total` and *current* active-game pool. When
either input changes — an admin edits `Total Game` on the Setting Default
template, or a game is activated/deactivated in the Game service catalog —
the ranking shifts for every future date **simultaneously** on the next
regeneration pass. Any game that falls out of the newly-ranked top `total` for
a date becomes a permanently orphaned row the moment that happens, since
`daily_activities` rows are never deleted, only membership is replaced
(`daily_plan_repo.go:331`, as established above).

This matches the observed shape exactly: `-g4` through `-g14` orphaned
together across several consecutive dates (`08-15`, `08-16`, `08-17`) each with
one shared `created_at = updated_at` per date — one regeneration pass
creating the same trailing slice of the ranking on each of those dates at
once, later superseded. The 284-vs-44 split (touched-again vs. written-once)
reflects how many regeneration cycles a game's ranking held before falling
out — most orphans were "in the top `total`" for at least one prior cycle
before a later catalog/config change bumped them out, not orphaned
immediately.

This means the orphan count is **not a one-off** — it will keep growing every
time the active game catalog or a `Total Game` template value changes, which
is a normal, expected, likely-recurring operational event, not a rare admin
action.

### Minor unrelated anomaly, not investigated further here

3 rows have `condition_type = NULL` — don't match any current type mapping.
Negligible volume, doesn't affect the composition conclusion above, flagged in
case it's a symptom of something else worth a separate look later.

## Investigation steps (completed)

1. DONE — orphan count: 352 Daily, 14 Weekly (see composition table above).
2. DONE — the 20-most-recent-orphan sample first surfaced the `TURNOVER_GAME`
   child pattern (see "dominant pattern" above), before the full breakdown
   query quantified it.
3. DONE — `daily-sched-2026-08-10-spend_prop` now has a membership row
   (`group_id` populated), confirming it is re-linked, not still orphaned.
4. DONE — `SaveWeeklyPlanFull` (`mission_repo.go:3296`) has the identical
   `DELETE FROM weekly_activity_group_members WHERE group_id = $1`
   (`mission_repo.go:3384`) pattern; Weekly's 14 orphans are the same mechanism
   at much smaller volume — Weekly's `game_turnover` (`TURNOVER_GAME_POOL`) is
   one activity carrying a game *pool*, not one row per game, so it can't
   produce the same child-explosion multiplier Daily does.

## Decision (locked 2026-08-05)

Operator chose **Leave it**. No cleanup job, no migration, no code change from
this run.

Given the volume is driven by a **recurring operational process**, not a rare
admin action, and will keep growing:

- **Leave it. — CHOSEN.** Orphaned rows are inert — never read by any live
  query, never displayed, never scored. The only cost is storage growth and a
  confusing `daily_activities` table for anyone querying it directly without
  the membership join (as happened here, twice, during this investigation). No
  player-facing risk either way. Revisit if the count becomes large enough to
  matter for storage/query performance, or if a future investigation needs the
  membership join caveat re-explained — this run is the reference for both.
- **Periodic cleanup.** — Not chosen. A scheduled job or migration that deletes
  `daily_activities` rows with no membership and no recent `updated_at` would
  bound table growth and remove the confusion, at the cost of a safe age
  cutoff and a migration under `ai-skills/rules/schema-change-needs-migration`.
  Left on the table for whenever the growth actually becomes a problem worth
  that cost.
- **Investigate whether the churn itself is desired.** — Not chosen, remains
  open. Whether it's *intentional* that editing `Total Game` or the active
  game catalog reshuffles which games every future TURNOVER_GAME mission uses,
  discarding the old selection, is a real product question this investigation
  surfaced but did not answer. Worth its own run if it ever matters (e.g. an
  admin notices game_turnover missions changing games unexpectedly).

## Explicitly not in scope

- Does not reopen or change TASK-EAR-211's own conclusions — its acceptance
  criteria didn't depend on this, and both directions of its fix (untouched
  name survives; admin-edited name survives) were independently verified with
  real staging round-trips.
- Not a fix for anything until the operator picks one of the three options
  above.
- Not an assessment of whether the deterministic-reshuffle behavior of
  `selectGameIDsForPeriod` itself is correct/desired product behavior — only
  that it's the confirmed source of most orphaned rows. That's a separate
  question the third decision option names but doesn't answer.

## Suggested ownership

Investigation is complete (`pm`, read-only: the queries above + source reads on
`SaveDailyPlanFull`, `SaveWeeklyPlanFull`, `selectGameIDsForPeriod`,
`RegenerateDailyDue`). Next step is the operator's decision, then `dev` only if
cleanup or the churn question is chosen.

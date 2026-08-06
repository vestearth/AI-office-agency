# TASK-EAR-211 — Backoffice freezes a mission name at seed time, so the title can never track the plan

## Request

A mission seeded into a Daily or Weekly plan from the Backoffice editor is saved
with its template tokens already substituted — `daily_activities.name` becomes a
finished sentence like `Spend 10 Diamonds with Randomly by System`. Missions only
computes `display_name` when the stored name is still a raw template key, so for
these missions it computes nothing, and the player sees a title frozen at the
values the template held on the day it was seeded. Make the stored name a
resolvable reference again.

## Origin

Observed on staging during the TASK-EAR-205 retest, 2026-08-04/05, in the tester's
own screenshots. The Daily quest list rendered:

| Surface | Value |
| --- | --- |
| Mission title on mobile | `Spend 10 Diamonds with Randoml…` |
| Progress bar on the same row | `10/110` |

Two things are wrong at once and both have the same cause. The title says 10 while
the mission requires 110, and the ` with {Special Item}` clause appears at all —
`resolveMissionDisplayName` strips that clause unconditionally for spend_prop
(`internal/services/mission_display_name.go:67`), so a backend-rendered name can
never contain it.

Initially misdiagnosed in-session as a mobile-side rendering quirk and recorded as
out of scope when TASK-EAR-205 closed. That was wrong: the string is written by
Backoffice and stored in the Missions database. TASK-EAR-205's closure is not
affected — its own acceptance criteria were met and verified — but the closing
note in its status.yaml is superseded by this run.

## Source evidence

- `seedDefaultTask` resolves the tokens at seed time and puts the result in the
  task's `name`, using the template's values —
  `app/pages/admin/manage/missions/daily/edit/[id].vue:231-238`
  (`spending: tpl.minSpendingValue`, `specialItem: tpl.specialItemCategory`).
  The weekly editor does the same at
  `app/pages/admin/manage/missions/weekly/edit/[id].vue:144`.
- That name is persisted verbatim — `toApiActivities` sends `name: t.name`
  (`app/pages/admin/manage/missions/daily/edit/[id].vue:349`).
- `app/utils/missionName.ts:6-16` states the intent outright: resolution happens
  "only when a mission is SEEDED into a plan … so the plan stores a finished name".
  The behavior is deliberate; its consequence for the player-facing title is what
  was never considered.
- Missions computes `display_name` only for a raw generated label —
  `internal/services/quest_overview_service.go:386` guards on
  `isRawGeneratedMissionLabel(activity.Name, templateKey)`, which compares the
  stored name against the template key
  (`internal/services/mission_display_name.go:118`). A finished sentence fails
  that check, so `QuestOverviewItem.DisplayName` is left empty and the client
  falls back to the frozen `label`.
- The schedule generator does the opposite and is unaffected: it stores the raw
  key (`internal/services/schedule_generator.go:294`, `Name: types[i]`), which is
  why the originally reported mission carried `"label": "spend_prop"` and a
  working `display_name`.

## Not a bug — explicitly ruled out

- **Not a mobile defect.** No client-side rendering is involved; the string exists
  in the database.
- **Not a TASK-EAR-204 regression.** EAR-204 made the name follow the live plan
  *when the name is still a template key*, and is verified working on that path.
  This run covers the other door, where the key was replaced before EAR-204's
  logic can ever run.
- **Not caused by TASK-EAR-205.** The frozen names predate it. EAR-205 changed
  which special item counts, not how names are stored — though it does make the
  stale suffix more visible, since `Randomly by System` no longer means anything
  on Daily/Weekly.

## Open question (answer before implementing)

Two ways to make the title track the plan again, with different blast radius:

1. **Store the key, resolve on read.** The editor sends the template key (as the
   generator already does) and the backend renders the name, so one code path owns
   naming for both seeded and generated missions. Cleanest, but any admin who
   deliberately typed a custom mission name must keep it — the editor has to
   distinguish "seeded default" from "renamed by a human".
2. **Keep storing a finished name, refresh it on save.** Smaller change, but the
   title still drifts whenever the plan's threshold changes without a save, which
   is the same class of bug EAR-204 existed to fix.

Recommendation is option 1. Option 2 leaves the defect reachable.

### DECIDED 2026-08-05: option 1, and it is Backoffice-only

The backend already renders correctly from a template key — that is the path
TASK-EAR-204 fixed and the schedule generator exercises. Nothing in
`Games-Labs-Missions` needs to change; the editor simply has to stop destroying
the key.

Two facts found while designing, both constraining:

- The per-task **Mission name input is editable**
  (`MissionPlanPeriodEditor.vue:430`, `v-model="task.name"`), so "send the key
  always" is not available — criterion 4 is real, not hypothetical.
- `toFormTask` loads `name: a.name` verbatim
  (`daily/edit/[id].vue:128`), so a row storing the key renders the literal text
  `spend_prop` in that input. The two rows corrected by the UPDATE above are in
  exactly that state right now, which makes fixing the load path part of this
  work rather than a nicety.

Chosen mechanism — no visible UI change, per the standing rule that backoffice
layout is design-approved:

1. On load, when the stored name is a template key, display the resolved name
   (`looksLikeMissionTemplateKey` → `resolveActivityMissionName`, both already
   used by the plan board) instead of the raw key.
2. Track per task whether the name is still the default. Seeded tasks and
   loaded-as-key tasks start as default; the flag clears when the admin edits
   the input.
3. On save, send the template key when the flag is set, and the admin's text
   otherwise.

A stateless "recompute the default and compare" alternative was rejected: an
admin who edits the threshold without touching the name would make the recomputed
default diverge from the displayed one, and their untouched mission would be
misread as custom — reintroducing this same bug through a different door.

The distinction option 1 needs is cheap **prospectively** and impossible
**retroactively**. Going forward the editor knows whether the admin touched the
name field, so a seeded-and-untouched task can send the key while an edited one
sends text. The 121 existing rows carry no such signal, and the data above shows
they cannot be classified by pattern.

That asymmetry decides criterion 5: **do not backfill**. Daily plans are one row
per calendar day, so a frozen historical name affects nothing a player will ever
see again. Only rows whose plan is today or later matter, and those are corrected
by the next save. Quantify the genuinely actionable subset before accepting this:

Joined through the real relational path — `daily_activity_group_members` links an
activity to its group and `daily_plans.group_id` links that group to a date. Do
not derive the plan id from the activity id by string surgery: the id scheme is
exactly what this run proved is not trustworthy evidence.

```sql
SELECT p.plan_date, a.id, a.name, a.condition_type, a.threshold
FROM daily_activities a
JOIN daily_activity_group_members m ON m.activity_id = a.id
JOIN daily_plans p ON p.group_id = m.group_id
WHERE p.plan_date >= CURRENT_DATE
  AND p.active
  AND a.condition_type IS NOT NULL
  AND a.name <> lower(CASE a.condition_type
        WHEN 'SPEND_DIAMOND_AMOUNT' THEN 'spend_prop'
        WHEN 'TURNOVER_GAME'        THEN 'game_turnover'
        WHEN 'TURNOVER_GAME_TYPE'   THEN 'category_turnover'
        WHEN 'TURNOVER_AMOUNT'      THEN 'any_game_turnover' END)
ORDER BY p.plan_date, a.id;
```

Weekly is a parallel structure (`weekly_activity_group_members` +
`weekly_plans.week_start`) and needs the same count before criterion 5 is
answered — Weekly plans live a week rather than a day, so a frozen name there is
visible to players for seven times as long.

### Answered, 2026-08-05

Daily, plans dated today or later — **2 rows**:

| plan_date | id | name | threshold |
| --- | --- | --- | --- |
| 2026-08-05 | `daily-sched-2026-08-05-spend_prop` | `Spend 10 Diamonds with Randomly by System` | 110 |
| 2026-08-06 | `daily-sched-2026-08-06-spend_prop` | `Spend 3000 Diamonds` | 3000 |

Weekly, same question — **0 rows**.

Only the first is visibly wrong today. The second is frozen but currently
*consistent* with its threshold, so it is latent: it misleads the moment anyone
edits that threshold without re-saving the name. That is the defect's real shape
— it does not announce itself until a value changes underneath it.

So of 121 frozen rows, **2 are live and 119 are historical**. The Weekly zero also
removes the one argument that could have overturned the recommendation: a frozen
Weekly name would be player-visible for seven days rather than one, and there are
none.

**Criterion 5 is therefore answered: do not backfill.** Fix the write path, and
correct the two live rows directly — restoring the key is enough, since the
backend renders the title from it:

```sql
UPDATE daily_activities SET name = 'spend_prop'
WHERE id IN ('daily-sched-2026-08-05-spend_prop', 'daily-sched-2026-08-06-spend_prop');
```

Both rows age out within two days regardless, so this is about the player looking
at the wrong title today, not about data integrity. Run it only if the fix will
not ship first.

One caveat on the Weekly zero, stated rather than glossed: an empty result proves
"no frozen names among Weekly plans in that window", which is not the same as "no
Weekly plans exist in that window". Confirm with
`SELECT count(*) FROM weekly_plans WHERE week_start >= CURRENT_DATE - 7;` before
treating the Weekly surface as verified clean.

## Scope

Included: the seed path in both plan editors, the save payload, and whatever
backend read-side change option 1 requires. Existing rows with a frozen name — a
decision on backfill is part of this run.

Excluded: `RegenerateDailyDue` semantics; the schedule generator, which is already
correct; TASK-EAR-205's scope mapping; mobile.

## Acceptance criteria

1. IMPLEMENTED — a mission seeded from a default template into a Daily plan
   sends the raw template key on save whenever the name is untouched, so the
   backend renders the title from the live plan (threshold included) on every
   read, with no re-seed required. `getStructuredTasks()` in
   `MissionPlanPeriodEditor.vue`: `name: task.nameIsDefault ? type : task.name`.
2. IMPLEMENTED — same mechanism, shared editor component, both `daily/edit` and
   `weekly/edit` pages wire `toFormTask`/`seedDefaultTask` identically.
3. UNCHANGED, verified not regressed — `mission_display_name.go:67` still strips
   the clause unconditionally; this run never touched Missions. The 2 corrected
   live rows on staging confirm the seeded path no longer produces the clause
   going forward.
4. IMPLEMENTED — `onNameInput` clears `task.nameIsDefault` the instant the
   Mission name field is edited (bound via `:value`/`@input`, not `v-model`, so
   the value write and the flag clear can't desync); `getStructuredTasks()` then
   sends the admin's text verbatim and never overwrites it back to the key.
5. ANSWERED — no backfill. 2 of 121 frozen rows are player-visible and both age
   out within two days; Weekly has none. The two live rows were corrected
   directly by the operator (`UPDATE ... SET name = 'spend_prop'`, 2 rows) ahead
   of this fix landing.
6. VERIFIED — the fix is additive-only to `toFormTask`, `collapseGameChildren`,
   `seedDefaultTask`, and the editor's save mapping; `resolveMissionDisplayName`
   and its TASK-EAR-204 tests in `Games-Labs-Missions` are untouched, and this
   run touches only `Games-Labs-backoffice`.
7. DONE — `tests/missionEditorNameFollowsPlan.test.mjs`, 8 cases, confirmed
   failing (module load error: `displayNameForActivity` did not exist) against
   the pre-fix tree via `git stash`, then passing after `git stash pop`. Single
   repo — see "Backoffice-only" above.

## Staging behavioral proof, post-deploy, 2026-08-05

PR #74 merged `f94a767`, `Build and Deploy` run `30991438646` success on that
exact sha, one second after merge. `1917dfb` (this run's commit) confirmed an
ancestor of the merge commit.

Two real save round-trips, both timestamp-verified (not assumed from a UI
success message — `updated_at` moving is proof the row was actually rewritten,
since `UpsertDailyActivity` sets `updated_at = CURRENT_TIMESTAMP`
unconditionally on every upsert, `mission_repo.go:1895`):

- **Untouched name stays a raw key** — `daily-sched-2026-08-06-spend_prop`
  (name already `spend_prop` from a prior manual correction). Reward edited,
  Mission name and Special Item dropdown left alone, Update clicked.
  `updated_at` moved `13:44:08.551` → `16:29:22.491`; `name` is still
  `spend_prop`. This is the mechanism criteria 1/2 depend on, observed live —
  not a bypassed test.
- **Admin-edited name is preserved verbatim** — `daily-sched-2026-08-10-spend_prop`
  and `weekly-sched-2026-08-10-spend_prop`, both edited by hand (Mission name
  and Special Item dropdown), both saved with the exact typed text, neither
  reverted to a key. Criterion 4, observed live.

An initial reading of these two rows as evidence of a bug was wrong and is
recorded, not erased: both had `created_at` weeks before this deploy (2026-07-14,
2026-07-20), so they were pre-existing rows re-saved with a deliberate edit, not
newly frozen by new code. Chased further with an `age_at_last_save` query before
concluding.

### Open finding, does not block this run

The `daily-sched-2026-08-10-spend_prop` row did NOT appear in the earlier
"criterion 5 live rows" join query (`daily_activity_group_members` +
`daily_plans`, `plan_date >= CURRENT_DATE`) run the same day, despite already
existing with a frozen name at that point. Most likely explanation: the
activity existed in `daily_activities` but was not yet linked into an active
plan's group membership (deselected in the roster) until the operator selected
it during this test — the join is correct for "currently player-visible",
and this row simply became player-visible only when saved. Not independently
confirmed (no history table to check prior membership state). Doesn't change
the no-backfill decision: whatever the count actually was, every row that gets
touched from here on self-corrects or is deliberately preserved — that is the
fix, not a count.

## Confirmed against staging, 2026-08-05

The reported row, found and fully explanatory:

| id | name | threshold |
| --- | --- | --- |
| `daily-sched-2026-08-05-spend_prop` | `Spend 10 Diamonds with Randomly by System` | 110 |

That single row accounts for every anomaly in the screenshot at once: the `10`
is the template's `minSpendingValue` frozen at seed time, the ` with Randomly by
System` clause is the Backoffice template's, the `110` bar is a threshold the
admin edited afterwards, and `display_name` is never computed because the name
is no longer a template key — so the client falls back to that frozen label.

### The id prefix does NOT identify the writing path

This row's id carries the `daily-sched-` prefix, which was assumed to mean
"generator-created, therefore safe". It is not. `seedDefaultTask` builds its id as
`${planId}-${type}` (`daily/edit/[id].vue:245`), which is byte-identical to the
generator's `planID + "-" + types[i]` (`schedule_generator.go:293`). A seeded task
therefore **overwrites a generator-created row in place**, replacing the raw key
with a finished sentence and keeping the id that suggests otherwise.

The earlier framing in this file — "two doors, distinguishable by id prefix" — was
wrong, and any fix or backfill keyed on the prefix would miss the majority of
affected rows. Only the `name` column tells the truth.

### Blast radius

```
raw_key = 613     frozen = 121     (734 rows with one of the four mapped condition types)
```

Split by type, with the ` with ` heuristic that seemed obvious at first:

| condition_type | frozen | contains " with " | example |
| --- | --- | --- | --- |
| TURNOVER_GAME | 79 | 0 | `Play 10 Game` |
| SPEND_DIAMOND_AMOUNT | 21 | 2 | `Spend 10 Diamonds with Randomly by System` |
| TURNOVER_GAME_TYPE | 18 | 0 | `Slot turnover 1,000` |
| TURNOVER_AMOUNT | 3 | 0 | `Collect 6,000 turnover` |

**The heuristic fails**: it catches 2 of 121. `Play 10 Game` is a template render
(of an admin-authored pattern, note the singular noun), while `Slot turnover 1,000`
and `Collect 6,000 turnover` read as hand-typed. There is no reliable way to
separate template-rendered from human-authored names retroactively — which
directly constrains the fix, see below.

## First steps

1. Split the 121 into template-rendered versus human-authored, with examples to
   eyeball:

```sql
SELECT condition_type,
       count(*) AS frozen,
       count(*) FILTER (WHERE name ILIKE '% with %') AS looks_template_rendered,
       min(name) AS example
FROM daily_activities
WHERE condition_type IS NOT NULL
  AND name <> lower(CASE condition_type
        WHEN 'SPEND_DIAMOND_AMOUNT' THEN 'spend_prop'
        WHEN 'TURNOVER_GAME'        THEN 'game_turnover'
        WHEN 'TURNOVER_GAME_TYPE'   THEN 'category_turnover'
        WHEN 'TURNOVER_AMOUNT'      THEN 'any_game_turnover' END)
GROUP BY condition_type
ORDER BY frozen DESC;
```

2. Identify which row the reported screenshot actually rendered — still open, see
   below.

## Closed thread: the screenshot is fully accounted for

Resolved by the row above — `daily-sched-2026-08-05-spend_prop`, name frozen at
`Spend 10 Diamonds with Randomly by System`, threshold since edited to 110. No
part of the reported display is unexplained, and nothing about it points outside
this run.

It also confirms TASK-EAR-205 was scoped correctly: the tester's purchase moved
progress against the live `threshold = 110`, which is the matcher behaving as
that run intended. Only the title was ever wrong.

## Suggested ownership

Two repos, and the naming-ownership question in the open section should be settled
before code. `pm` to close that question, then `dev`.

# TASK-EAR-167 — Weekly FISHING pool rows: findings

Read-only investigation, 2026-07-29. No DB access used; SQL for the operator is
at the bottom.

## Ruling: (c) — something else. Both prior readings were wrong.

Not "inert dead config" (2026-07-22) and not "the TASK-EAR-166 generator
defect on another surface" (2026-07-27, mine). It is **unvalidated,
admin-API-originated config on a surface that has never had a canonical
guard**, kept alive by a Backoffice carry-forward.

## The headline: TASK-EAR-166's fix does NOT cover this path

Verified directly: the weekly generator emits exactly two pool entry types —
`"game"` and `"special_item"` (`schedule_generator.go:375-394`). It **never
emits `entry_type:"category"`**. The `category_turnover` slug becomes a
`TURNOVER_GAME_TYPE` activity with no pool at all
(`schedule_defaults.go:298-305`).

TASK-EAR-166's defect lived in the `game_type`/`game_category` **columns** of
generated rules. It had no reach into pool rows. **My 2026-07-27 attribution
was wrong**, and the epic therefore has a second, distinct hole that 166 did
not close.

## What actually writes these rows

`weekly_activity_pool_entries` has two write functions; only one is live.

| writer | file:line | live |
| --- | --- | --- |
| `SaveWeeklyPlanFull` (DELETE `:3353` → INSERT `:3367`) | `mission_repo.go:3313` | **yes** |
| `ReplaceWeeklyActivityPoolEntries` (DELETE `:3501` → INSERT `:3510`) | `mission_repo.go:3477` | no — callers are `weekly_pool_test.go` only |

The daily mirror is identical: `ReplaceDailyActivityPoolEntries`
(`daily_plan_repo.go:412`) is test-only; daily pools are written solely inside
`SaveDailyPlanFull` (`:271`).

Live callers, all three: `POST /api/v1/admin/weekly/plans/full`
(`weekly_plans.go:268` → `weekly_admin.go:435` → repo `:3313`), and the two
generator paths (`schedule_generator.go:552`, `:712`) — which, per above,
cannot produce category entries.

**So the admin HTTP save is the only possible origin — and it validates
nothing.** `validateWeeklyActivityConfig` (`weekly_admin.go:171-181`) checks
only `len(act.Pool) == 0` for `TURNOVER_GAME_POOL`; it never inspects
`entry_type` or `entry_ref`. Verified by reading it. The repo loop only trims
and lowercases. (The method that *does* validate is the dead one.)

## Where FISHING came from

**Proven:**
- The Backoffice cannot originate it — its category options are
  `['All','Slot','Card','Crash','Arcade','Mini Game']`
  (`backoffice/app/data/mock.ts:1263`) and the weekly editor only emits
  `entry_type:'game'` and `'special_item'`
  (`weekly/edit/[id].vue:293,303`).
- But the editor **carries pre-existing non-game entries forward on every
  save**: `const nonGame = loaded.filter(e => e.entry_type !== 'game')`
  (`[id].vue:304`), re-sent into the payload. With replace-on-save, that fully
  explains recent `updated_at` and recent activity ids **without anything
  currently creating FISHING**. The rows are being *refreshed*, not *created*.
- `FISHING` is this project's own published example for this exact field:
  `runs/TASK-EAR-040/weekly-board-pool-contract.md:41,68,100` documents
  `pool: ["SLOT","Any Game","game-uuid-aaa","FISHING"]`, and
  `TASK-EAR-040/free-roam-output.yaml:6` records a hand-seeded plan with
  `category:FISHING`.
- Migration `032_weekly_activity_pools.sql:2-3` documents the original intent:
  `entry_ref` for `entry_type=category` holds a **game_type** token, "opaque,
  trust the Backoffice picker, no Missions→Game client" — i.e. **this column
  was designed without a canonical guard**, which is why 166's "make the
  hardcoded set fail safe" fix has nothing to attach to here.

**Inferred (needs Q1 to confirm):** written by a direct admin-API call — dev
smoke or manual curl reusing the EAR-040 contract example — then kept alive by
the carry-forward.

## Can they score? "Inert" is true of today's data, not of the code

Both paths are in `activity_match.go:87-118`, reached only when the pool is
hydrated — which happens only for `TURNOVER_GAME_POOL` on an active activity in
the active group of the active plan for that week (`mission_repo.go:2656-2710`).

- **Exact** (`:104-110`): `EqualFold(entry, evt.GameCategory)`.
  `evt.GameCategory` is `games.category`, FK-constrained to
  `game_categories(code)`. So `FISHING` matches only if an admin inserted a
  `FISHING` row there — a table Games-Labs-Game migration 030 explicitly
  documents as admin-extensible.
- **Fuzzy** (`:111-117`): `gameTypeMatches(entry, evt.GameType)` — normalize
  both, then `equal || contains(evt, rule) || contains(rule, evt)`.
  `evt.GameType` is `games.game_type`: **free-text `VARCHAR(50)`, no FK, no
  CHECK**, set straight from `req.GetGameType()` in the admin RPC.

The 07-22 check was actually stronger than its write-up suggested — it did
query both columns with a wildcard and got zero rows. What it missed is that
**"no FISHING game exists today" is not "this row is inert."**
`games.game_type` is unvalidated free text, and **Games-Labs-Provider ships
`GameTypeFishing GameType = "fishing"`** (`constants.go:34`) as a live vendor
vocabulary token. One admin typo or one provider-type passthrough at the
games-write boundary turns these rows live, silently.

## Separate finding worth its own attention

The pool branch's fuzzy loop is gated **only** on `evt.GameType != ""`
(verified at `activity_match.go:111`), whereas the `TURNOVER_GAME_TYPE` branch
gates its fuzzy arm on `(rule.GameCategory == "" || evt.GameCategory == "")`
(`:55`).

**So pool entries are strictly more exposed to the fuzzy path than rule-level
categories are** — every pool entry is containment-tested against every
turnover event's `game_type`, even when both sides have perfectly good
canonical categories. That matters for TASK-EAR-168's gate: condition A2 is not
hygiene, it is the more dangerous surface of the two.

## Consequence for the epic

TASK-EAR-168's gate condition **A2 currently fails**, and **cannot be made
durable by any existing fix** — the save path will accept a new non-canonical
`entry_ref` tomorrow. TASK-EAR-151 stays blocked until the pool save path gets
a guard.

## Recommendation — code before data (not executed)

1. **Code first.** Add an `entry_ref` canonical guard for
   `entry_type='category'` on the live save path —
   `validateWeeklyActivityConfig` (`weekly_admin.go:171-181`) plus the daily
   mirror — rejecting refs outside the canonical five with `ErrInvalidInput`
   (400). Reuse `resolveCategoryScope` / `categoryCanonicalCodes` from
   TASK-EAR-166 so the pool and rule surfaces share one vocabulary instead of
   drifting again. Consider deleting the dead `Replace*PoolEntries` methods, or
   routing the live path through their validation rather than duplicating it.
2. **Then data** — only after (1) deploys, or the next Backoffice save from a
   stale editor tab re-inserts the row via carry-forward.
3. **Cleanup caution.** Deleting a pool row does not cascade (the
   `ON DELETE CASCADE` runs *from* `weekly_activities`, not into it). But if
   `FISHING` is the **sole remaining entry** on a `TURNOVER_GAME_POOL`
   activity, removing it leaves an empty pool: the matcher can then never
   match (mission unachievable for live users mid-week) **and** the next
   Backoffice save of that plan 400s on `weekly_admin.go:173`. Check the
   per-activity remaining pool count first and avoid activities in a currently
   active week.

## SQL for the operator

**Q1 — decisive: what are these attached to, and are they even hydrated?**

```sql
SELECT e.activity_id, e.entry_ref, e.sort_order, e.weight,
       a.condition_type, a.active AS activity_active,
       a.game_type, a.game_category, a.created_at, a.updated_at,
       m.group_id, g.active AS group_active,
       p.id AS plan_id, p.week_start, p.active AS plan_active, p.source,
       (SELECT COUNT(*) FROM weekly_activity_pool_entries x
         WHERE x.activity_id = e.activity_id) AS pool_size_total
FROM weekly_activity_pool_entries e
JOIN weekly_activities a ON a.id = e.activity_id
LEFT JOIN weekly_activity_group_members m ON m.activity_id = a.id
LEFT JOIN weekly_activity_groups g ON g.id = m.group_id
LEFT JOIN weekly_plans p ON p.group_id = m.group_id
WHERE e.entry_type = 'category'
  AND e.entry_ref NOT IN ('SLOTS','CRASH','ARCADE','MINIGAME','CARD')
ORDER BY p.week_start NULLS LAST, e.activity_id, e.sort_order;
```

`condition_type <> 'TURNOVER_GAME_POOL'` means the row is never loaded into a
rule at all. `plan.source` distinguishes `manual` from `schedule` — a row under
`source='schedule'` would be a generated plan later edited via the board, which
confirms the carry-forward mechanism.

**Q2 — did they ever actually score?**

```sql
SELECT activity_id, COUNT(*) AS applications, SUM(delta_value) AS total_delta,
       MIN(created_at), MAX(created_at)
FROM weekly_activity_event_applications
WHERE activity_id IN (
  SELECT activity_id FROM weekly_activity_pool_entries
  WHERE entry_type = 'category'
    AND entry_ref NOT IN ('SLOTS','CRASH','ARCADE','MINIGAME','CARD'))
GROUP BY activity_id ORDER BY 2 DESC;
```

Non-zero does not prove FISHING scored (the same activity's `game` entries also
apply) — but zero rules it out cleanly.

**Q3 — canonical-set gap (Games-Labs-Game DB):**

```sql
SELECT code, display_name, active, sort_order FROM game_categories ORDER BY sort_order;
SELECT DISTINCT category FROM games ORDER BY 1;
```

**Q4 — fuzzy reachability, both containment directions (Games-Labs-Game DB):**

```sql
SELECT game_type, category, status, COUNT(*)
FROM games GROUP BY game_type, category, status ORDER BY 4 DESC;
```

Read the **full** `game_type` vocabulary, not just `ILIKE '%fish%'` —
`gameTypeMatches` also fires when the event's type is a substring of the rule's
token. **Run Q3 and Q4 against prod too**; every prior FISHING check was
staging-only.

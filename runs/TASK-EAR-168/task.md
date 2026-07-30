# TASK-EAR-168 — Redefine the TASK-EAR-151 gate (current one is unsatisfiable)

## Type

investigation

## Workstream

backend

## Priority

medium

## Created

2026-07-29

## Epic

Canonical game-classification (TASK-EAR-140..153). Blocks TASK-EAR-151
alongside TASK-EAR-166 — 166 fixes the defect, this task defines how we prove
it is safe to retire the fallback.

## Context

TASK-EAR-151's gate says: `applied_forward_legacy_fuzzy == 0` over an agreed
retention window, queried as

```sql
SELECT status, COUNT(*) FROM daily_activity_consumer_events GROUP BY status;
```

TASK-EAR-162's run exposed **three independent defects in that gate**:

1. **It counts all history with no time predicate.** Once a single fuzzy row
   exists it can never return to zero without deleting history — so the gate
   is unsatisfiable by construction, regardless of any fix. The product intent
   was always "zero **over the retention window**"; the query never expressed
   that. (Measured 2026-07-29: 20 fuzzy rows, of which 16 are from 07-22 and
   4 from 07-24 — all before any fix could exist.)
2. **An event count cannot prove the invariant we actually care about.** The
   real question is "can a rule with an empty `game_category` still be
   created?" A quiet metric only means nobody triggered one recently — and
   because the schedule generator regenerates rules every period, a passing
   reading can be invalidated the next cycle without any code change.
3. **It is structurally blind to weekly.** Weekly missions use a separate
   2-table event source (`weekly_activity_progress` /
   `weekly_activity_event_applications`, from TASK-EAR-021) with **no status
   column at all**, so `ViaFallback` is computed for weekly deltas and has
   nowhere to persist. A daily count of 0 says nothing about weekly.

There is also a **traffic-validity** problem: on 2026-07-25 and 07-27 staging
produced only 2 exactly-applied events per day. A zero reading against that
volume is not evidence of anything, and nothing in the current gate detects
that the sample was too small to be meaningful.

Full evidence: `runs/TASK-EAR-162/gate-check-findings.md`.

## Objective

Define a gate that can actually be satisfied and that actually proves safety,
then record it so TASK-EAR-151's task file can be updated to use it.
**Deliverable is the gate definition — do not execute it or act on
TASK-EAR-151.**

## The gate must cover

1. **A time-bounded metric** — an explicit cutoff (e.g. events created after
   TASK-EAR-166's deploy timestamp), not lifetime totals.
2. **A minimum-traffic condition** — a floor below which a zero reading is
   declared "not evaluated" rather than "passed". Pick the floor from observed
   staging volume; note that recent daily volume has been in the single digits,
   so this may mean the gate cannot be evaluated on staging at all without
   generated load — say so if that is the conclusion.
3. **A config invariant, not just a count** — a direct check that no
   category-scoped rule exists with an empty `game_category`, across **every**
   surface that stores one: `daily_activities`, `weekly_activities`,
   `daily_activity_pool_entries`, `weekly_activity_pool_entries`. This is the
   condition that actually makes removing the fallback safe; the event metric
   is corroborating evidence, not proof.
4. **Weekly observability** — decide and state one of:
   - add a status/ledger column to the weekly event source mirroring the daily
     one (a real schema change, scope it), or
   - accept that weekly is proven by the config invariant alone and document
     that explicitly as a deliberate limitation.
   Do not leave weekly implicitly "covered" by a daily metric that cannot see
   it — that ambiguity is what let this epic reach its final phase with the
   defect still live.

## Acceptance criteria

- A written gate definition with the exact queries/checks, their pass
  conditions, and what each one does and does not prove.
- The weekly decision made explicitly, with its cost if it implies a schema
  change.
- A clear statement of where the gate can be evaluated (staging traffic may be
  too thin — if so, say what would be needed).
- A recommendation for updating `runs/TASK-EAR-151/task.md`'s Gate section,
  written so it can be applied directly. **Do not edit TASK-EAR-151's files
  in this task** — propose the replacement text.

## Out of scope

- Fixing the generator (TASK-EAR-166).
- Running the new gate or acting on TASK-EAR-151.
- Tracing the weekly FISHING rows (TASK-EAR-167).

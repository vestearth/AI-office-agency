# TASK-EAR-146: Game classification epic — Phase 0: audit + canonical game_category set

## Type

research

## Workstream

backend

## Priority

high

## Created

2026-07-18

## Epic

Canonical game-classification (game_category) — Phase 0 of 5. Unblocks
147/149. See knowledge-base "Game Type Vocabulary — Root Cause + Canonical
Enum Epic Plan".

## Goal

Produce the canonical `game_category` taxonomy and the complete mapping tables
that every downstream phase seeds from. This is the product-decision gate: no
code phase starts until the canonical set is signed off.

Background: mission scoping needs a mid-level category taxonomy that does not
exist today. `games.game_type` is a per-game mechanic (`HEIST MINES SLOTS
CROSSING MONOPOLY CRASH PLINKO MINIGAME BOUNCY` on staging); `games.category`
is a separate display free-text column; the mission dropdown
(`Slot/Card/Crash/Arcade/Mini Game`) is a third, disconnected vocabulary. See
TASK-EAR-140 for the bug this epic closes properly.

## Deliverables

1. Actual distinct values, **staging AND prod**, of `games.game_type` and
   `games.category` (SELECT DISTINCT ... GROUP BY count), plus current
   daily_activities / weekly_activities `game_type` values in Missions.
2. Proposed **canonical `game_category` code list** (stable UPPER_SNAKE
   `code` + display name), reviewed against product intent for mission
   scoping.
3. **game -> game_category mapping** (seed data for Phase 1 / TASK-EAR-147):
   every active game assigned exactly one canonical code. `games.category`
   values are the audit seed for this mapping, not the canonical home.
4. **legacy mission-config mapping** (for Phase 3 / TASK-EAR-149): each
   existing daily/weekly `game_type` token -> canonical code, with any
   unmappable token flagged (those keep the fuzzy fallback).
5. Operator / product **sign-off** on 2 and 3.

## Findings (staging, 2026-07-18) — audit complete, decisions LOCKED

Operator pulled `SELECT game_type, category, COUNT(*) FROM games WHERE
status='active' GROUP BY game_type, category` on staging (DB `gamelabs`).
Result: `games.category` is **not messy free text** — every `game_type`
(mechanic) maps to exactly one `category` (broad grouping), deterministically:

| game_type (mechanic) | category | count |
| --- | --- | --- |
| SLOTS | SLOTS | 160 |
| BOUNCY | ARCADE | 7 |
| CROSSING | ARCADE | 3 |
| CRASH | CRASH | 3 |
| HEIST | MINIGAME | 2 |
| MINES | MINIGAME | 2 |
| MINIGAME | MINIGAME | 4 |
| MONOPOLY | MINIGAME | 4 |
| PLINKO | MINIGAME | 2 |

`games.category` is already admin-maintained and already close to what mission
scoping wants — it does not need a new parallel column or a messy-data
cleanup pass. This **simplified the epic architecture** (locked with operator,
2026-07-18):

- **Reuse the existing `games.category` column as the canonical field.** Add
  a new `game_categories` lookup table + a **foreign key on the existing
  `category` column** referencing it. No new column, no backfill (values
  already match) — this replaces the originally-drafted
  `game_category_code` new-column design in TASK-EAR-147/148.
- **Canonical v1 code set: `SLOTS, CRASH, ARCADE, MINIGAME, CARD`.** `CARD`
  is kept for a future card-game category despite 0 games today (previewed
  as "0 games" in Backoffice per TASK-EAR-150/141, not dropped) — operator
  decision, not a data artifact.
- **Legacy Missions mission-config mapping** (config tokens from
  `missionCategoryToApiGameType`, TASK-EAR-140): `SLOT -> SLOTS`,
  `CRASH -> CRASH`, `ARCADE -> ARCADE`, `MINIGAME -> MINIGAME`,
  `CARD -> CARD`. Canonical spelling picked as `SLOTS` (matches 160 existing
  game rows) rather than migrating those rows to `SLOT` (cheaper to migrate
  the handful of mission-config rows than the game catalog).

## Acceptance

- [x] Canonical code list signed off: `SLOTS, CRASH, ARCADE, MINIGAME, CARD`.
- [x] Staging distinct values audited; game_type -> category mapping is
      deterministic (table above).
- [x] Legacy mission-config mapping locked (SLOT -> SLOTS et al.).
- [ ] **Remaining:** prod `SELECT DISTINCT category FROM games` has not been
      pulled yet. Not a hard gate on starting 147 (the FK constraint fails
      safely — a migration error, not data corruption — if prod has an
      uncovered value); TASK-EAR-147 runs this as its own pre-flight step
      and adds any missing code to `game_categories` before applying the FK.
- Downstream tasks 147, 148, 149, 150 seed directly from the mapping above.

## Notes

- Out of scope for the whole epic: curated `categories`/`category_games`
  display tables, Mobile game list, provider-native `game_type` (mapped only
  at the import boundary).

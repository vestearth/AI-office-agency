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

## Acceptance

- Signed-off canonical code list committed (to this run and/or the KB epic
  note).
- Every active game has a proposed assignment; no game left unmapped.
- Every existing mission-config game_type token is mapped or explicitly
  flagged as fallback-only.
- Downstream tasks 147 and 149 can seed directly from these tables.

## Notes

- Needs a DB read on staging + prod (operator/devops) and a product call on
  the canonical set — not a pure code task.
- Out of scope for the whole epic: curated `categories`/`category_games`
  display tables, Mobile game list, provider-native `game_type` (mapped only
  at the import boundary).

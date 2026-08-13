# TASK-EAR-248 — Games list Special Pass column shows Store Pass names

## Type

feature

## Workstream

frontend

## Priority

medium

## Created

2026-08-10

## Context

Game edit Special Pass already syncs read-only from Store Passes
(`listAllItems({ itemType: 'pass' })` + `resolveGamePassSupport` / PR #86).
The games list (`admin/games`) still has an empty Special Pass cell
(`&nbsp;`) even though `specialPassLabel` is mapped from the games API
(which does not own pass coverage).

Operator asked to show Pass names from `admin/manage/store/items` that
are linked to each game (name is enough).

## Goal

On `admin/games`, the Special Pass column shows the name(s) of active
Store Pass items that cover that game — same coverage rules as Game edit.

## Scope

- Included: `Games-Labs-backoffice` only
  - `app/pages/admin/games/index.vue`
  - optional small helper + test next to `gamePassSupport.ts`
- Excluded: Game edit (already wired), Bet Limit (TASK-EAR-242), backend,
  store Pass create/edit, EAR-232 worktree/audit work

## Acceptance Criteria

- Special Pass column renders Pass `name` for games covered by active
  Store Passes (Level Access via `gameIds`, Point Multiplier all games).
- No covering pass → `—` (not a blank/`&nbsp;` cell).
- Reuses `resolveGamePassSupport` / store `listAllItems`; does not invent
  a second coverage rule.
- Focused unit coverage for name formatting / coverage join on the list.
- PR only — do not merge (backoffice `main` = real deploy).

## Notes

- Coverage ownership stays on Manage → Store → Pass (`gameIds` /
  Point Multiplier), same as Field Lineage / PR #86.

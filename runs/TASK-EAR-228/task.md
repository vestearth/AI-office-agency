# TASK-EAR-228 — Game List Tag column reads is_hot / is_new

## Request

Follow-up to TASK-EAR-224. After wiring Game edit Tags save, the Manage >
Game list still shows `—` in every Tag cell.

## Root cause

`app/pages/admin/games/index.vue` `mapApiToRows` mapped:

- `isPopular: Boolean(game.isPopular)`
- `isNew: Boolean(game.isNew)`

`ListGames` returns `gamepb.Game` with `is_new` / `is_hot` (JSON `isNew` /
`isHot`). There is no `isPopular` field, so Hot never lights; `isNew` alone
was also unsafe without snake_case fallback.

## Scope

- `Games-Labs-backoffice` only: map Tag from `is_hot`/`isHot` +
  `is_new`/`isNew` (reuse `useGameTagOptions`); focused tests.
- Excluded: backend/proto, Game edit page (already wired in EAR-224).

## Acceptance criteria

1. A game with `is_hot: true` shows Hot in the list Tag column.
2. A game with `is_new: true` shows New.
3. Neither flag → `—`.
4. Focused tests cover `tagFlagsFromApiGame` + list mapping source assert.

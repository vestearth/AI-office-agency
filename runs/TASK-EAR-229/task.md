# TASK-EAR-229 — Let the Game edit page change VIP Level for a game that is in a Level Group (move + sync)

## Request

On `admin/games/edit/[id]`, changing **VIP Level** and saving does not stick for
any game that belongs to a Level Group — the backend silently forces the level
back to the group's level. Operator decision: make the field actually editable,
and have the change **move the game between Level Groups** so `games.level` and
`level_group_games` stay consistent.

## Current behaviour (verified in source, 2026-08-07)

`Games-Labs-Game/internal/core/repositories/game.go:538-547` — the Level Group
wins unconditionally:

```go
level := existing.Level
inLevelGroup := false
if cfgLevel, ok, err := r.levelConfigLevelForGameTx(ctx, tx, gameID); ok {
    level = int64(cfgLevel)   // group wins, req.Level discarded
    inLevelGroup = true
} else if req.Level > 0 {
    level = req.Level
}
```

and the membership sync is gated off for exactly those games
(`game.go:577`): `if oldLevel != level && !inLevelGroup { sync... }`.

The sync itself already does the whole move —
`syncLevelGroupGamesAfterLevelChange` (`level_group.go:599-630`) deletes the
existing `level_group_games` row, finds the group whose `level_config_level`
matches the new level, and inserts the game at `MAX(sort_order)+1`. So the
missing piece is the guard, not the mechanism.

Frontend is already honest about it — `[id].vue:444-448` compares the level in
the `UpdateGame` response against what it sent and toasts "…is managed by a
Level Group, so its VIP Level follows the group and stayed at VIPx". That
message becomes wrong once this run lands and must go.

`VIP_OPTIONS` is already catalog-driven (`useGameLevelOptions.ts:32`), not the
old hardcoded VIP1-8, so no picker work is needed.

## Operator decisions (already made — do not re-open)

1. **No group exists for the target level → orphan is allowed.** The game is
   removed from its old group, `games.level` is set to the requested value, and
   it belongs to no group. This is the existing `ErrNoRows → return nil` branch
   at `level_group.go:612`; keep it, do not add a validation error and do not
   auto-create a group.

## Design

- `Update` (transactional path): `req.Level > 0` wins over the group's level.
  Run `syncLevelGroupGamesAfterLevelChange` whenever the level actually
  changed, regardless of prior membership. Drop the `inLevelGroup` flag.
- `updateGameRow` (`game.go:591`, non-transactional) must apply the **same
  merge rule** so tests do not encode the retired "group wins" semantics. It is
  a test-only path in practice (`NewGameRepository` sets `beginPool = pool`,
  `game.go:31`), so it does not need the membership sync — but the level merge
  must match, and that limitation should be stated in a comment.
- Frontend confirm step: before saving a level change, the confirm dialog must
  state what will happen to group membership. This needs **two** existing admin
  endpoints — no proto field is added, because a new field on the Game message
  would require a shared-lib bump on the gateway's staging lane that this change
  does not otherwise need:
  - `GET /api/v1/admin/group/level-games/by-level/{level}` (`GetLevelGameGroupByLevel`)
    — is this game currently a member of a group.
  - `GET /api/v1/admin/group/level` (`ListLevelGroup`) — the group **labels**, and
    whether a group exists for the target level at all. The by-level response
    carries only `LevelGroupGame` rows, which have `group_id` but no group name
    (`admingame.proto:730-742`); `LevelGroup.games` (field 7) is never populated
    by `ListLevelGroups` (`level_group.go:149-172`), so one call cannot answer
    both questions.
- Confirm copy must branch on all four cases, not one:
  1. in group A → group B exists: "moved from <A> to <B>, ordering is lost"
  2. in group A → no group for target level: "removed from <A>; the game will not
     belong to any Level Group"
  3. not in a group → group B exists: "will be added to <B>"
  4. not in a group → no group: plain level change, no membership language
- **Membership lookup must fail closed.** Do not reuse
  `extractLevelGameGroupList` (`useVipLevelGames.ts:180-193`) as-is for this
  check: it returns `[]` for `success === false` and for any status code other
  than 200, which is indistinguishable from "this game is in no group". Reusing
  it means a failed lookup silently downgrades a group move to case 4 and the
  operator moves the game without ever seeing the warning. On lookup failure,
  block the save and surface an error instead of assuming no membership. (Note
  there is a second, page-local copy of the same function at
  `app/pages/admin/games/group/edit/[id].vue:244` — do not "fix" that one here.)
- Replace the "stayed at VIPx" toast branch with a real result message; keep the
  existing failure path.

## Known consequences to state, not to fix

Both are accepted deliberately. The reasoning is recorded here so a reviewer
does not re-litigate them, and so that whoever later decides they *are* worth
fixing knows exactly what changes.

### `sort_order` is lost on a move — and the old group is left with a gap

`syncLevelGroupGamesAfterLevelChange` removes the row with a plain
`DELETE FROM level_group_games WHERE game_id = $1` (`level_group.go:603`) and
re-inserts at `COALESCE(MAX(sort_order),0)+1` (`:620`). Compare the normal
removal path `DeleteLevelGroupGame` (`:242-249`), which does
`RETURNING sort_order` and then closes the hole with
`sort_order = sort_order - 1 WHERE sort_order > $2`. The sync does **not** do
that, so a move both appends the game to the end of the target group and leaves
a numbering gap in the source group.

Neither breaks anything:

- every read is `ORDER BY lgg.sort_order ASC, lgg.created_at ASC`
  (`:388`, `:514`), so gaps are invisible;
- the only unique constraints are `(group_id, game_id)` (migration 017) and
  `game_id` (migration 019) — there is **no** unique index on
  `(group_id, sort_order)`, so gaps or duplicate ordinals never fail an insert;
- the next drag-reorder from the Level Group page rewrites the whole set
  (`:493`) and the gap disappears on its own.

What is actually lost is merchandising order inside an admin screen. It does not
reach players: playability is decided from `games.level` directly —
`requiredLevel = game.Level` (`gamesvc/service.go:276`) then
`canPlayGameAtLevel(...)` (`:291`) — and the player-facing service never reads
`level_group_games` at all. `level_group_games` is an admin grouping surface,
not the authorization surface.

Fixing it properly would mean letting the operator choose a destination position
during the move, i.e. new UI on the Basic Info page — larger than this run and
against `preserve-ux-design-wire-data-only`. The Level Group page already has
drag-reorder for exactly this.

**Required instead:** the confirm dialog says ordering is lost, so the operator
knows before committing.

### Second writer on `level_group_games` (last-write-wins)

The Level Group page and this page now both mutate membership with no locking
between them. Two existing safeguards keep the blast radius small:

- the unique index on `game_id` (migration 019) enforces "one game, one group"
  at the database level no matter how many writers race. The worst outcome is a
  game sitting in an unintended group — visible on screen and fixable in
  seconds, not silent corruption;
- the whole update is one transaction (`game.go:489` Begin → `:583` Commit), so
  the `games` UPDATE and the membership delete/insert land together. The state
  the retired rule actually existed to prevent — level changed but membership
  not — remains impossible.

What is genuinely unguarded is the cross-transaction case: A opens the page
showing VIP3, B moves the game to VIP5, A saves and silently reverts it to VIP3.
Preventing that needs optimistic locking (send back the `updated_at` that was
read, reject on mismatch), which **no admin surface in this Backoffice has**.
Adding it to this one field would be a lone pattern nobody else follows, for a
handful of operators. If it is wanted, it belongs in its own Backoffice-wide
run, not bolted onto this one.

### Landmine: do not re-embed migration 020

`020_sync_game_level_from_level_groups.sql` force-realigns `games.level` from
`level_groups`. It is deliberately **excluded** from the boot migration runner
(`migrations/run.go:32-34`: "replaying it every boot would keep overwriting
games.level drift"), which matters more after this change than before — Game
replays every embedded migration on every boot with no version table
(`run.go:11-13`), so embedding 020 would drag every moved game's level back on
the next deploy. Leave it unembedded. Do not "restore" it while touching this
area.

## Scope

- Included: `Games-Labs-Game` — `Update` / `updateGameRow` level merge and sync
  gating; `Games-Labs-backoffice` — confirm-dialog copy, membership lookup, and
  the retired "follows the group" toast; tests on both sides.
- Excluded: proto / gateway changes (none needed), auto-creating a target group,
  preserving `sort_order` across a move, closing the `sort_order` gap left in the
  source group, optimistic locking / concurrent-edit protection, Level Group page
  changes, production deploy.

## Constraints

- Follow `preserve-ux-design-wire-data-only` — the VIP Level select and the
  Edit/Save button are design-approved; only the confirm copy and the wiring
  change.
- The move must stay inside the existing transaction: the `games` UPDATE and the
  `level_group_games` delete/insert commit together or not at all.
- Boot-time migration idempotency does not apply — no schema change here. But do
  not embed `020_sync_game_level_from_level_groups.sql` into the boot runner (see
  the landmine note above).

## Acceptance criteria

1. A game **in** a Level Group: change VIP Level → save → reload shows the new
   level, and the game now appears under the new group on the Level Group page
   and is gone from the old one.
2. Same flow where **no group exists** for the target level: level saves, game
   belongs to no group, no error surfaced.
3. A game **not** in any group keeps working exactly as it does today (level
   saves; joins the matching group if one exists).
4. A failed update still surfaces the real error; the "stayed at VIPx" toast no
   longer appears anywhere.
5. The confirm dialog states the membership outcome before any save, using the
   branch that matches the situation (see the four cases under Design). It names
   the source group when there is one and the target group when there is one, and
   warns that ordering is lost only on a move into a group — criterion 2's orphan
   case has no target group to name and must not claim one.
6. A membership lookup that fails (non-200, `success: false`, network error)
   blocks the save with a real error rather than silently falling through to the
   "not in a group" branch.
7. `games.level` and `level_group_games` never disagree after any of the above —
   assert both in the repository test, in one transaction.
8. Tests below all exist and pass; existing Go suite and Backoffice production
   build stay green.

## Required tests

Go (`Games-Labs-Game`, repository level — assert **both** tables in every case):

- group → group move: `games.level` updated, old `level_group_games` row gone,
  new row present in the target group.
- group → orphan (no group at target level): level updated, no membership row,
  no error.
- no group before → group exists: unchanged from today's behaviour.
- **rollback**: force the sync insert to fail inside the transaction and assert
  `games.level` **and** the original `level_group_games` row are both unchanged
  after the failure. Today's tests only exercise the success path, so nothing
  currently proves the atomicity that criterion 7 depends on.

Backoffice (`tests/*.test.mjs` — only `gameLevelOptions.test.mjs` covers this
area today, and only the VIP option helpers):

- confirm copy for each of the four Design cases, including that the orphan case
  names no target group.
- membership lookup failure blocks the save and surfaces an error (criterion 6).
- the save actually issues the `UpdateGame` request with the requested level.
- the "stayed at VIPx" toast branch is gone.

## Suggested ownership

Backend rule change plus a small Backoffice confirm-flow change — sequential,
one dev. Reviewer should check criterion 7 specifically (the two tables staying
in agreement is the whole point of the rule being removed) and the rollback test
that backs it.

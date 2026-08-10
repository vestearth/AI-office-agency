# TASK-EAR-246 — Close the `sort_order` gap left in the source Level Group after a VIP-level move

Follow-up to `TASK-EAR-229`. That run knowingly shipped a gap in
`level_group_games.sort_order` and justified it with "gaps are invisible".
That justification is now proven false: the Group Arrangement page renders the
raw `sort_order` as the card badge, so every gap is on screen.

## Evidence that reopens it

`app/pages/admin/games/group/edit/[id].vue` renders the badge as
`{{ card.sortOrder ?? idx + 1 }}` — the stored ordinal, not the array index.
EAR-229's premise (`ORDER BY lgg.sort_order` makes gaps invisible) holds for
ordering only, not for the number the operator reads.

Operator screenshots from staging, 2026-08-10:

- VIP2 group `019e249f-ddf7-77b9-8304-c60f2869e586` — 9 games badged 2…10, no 1.
  This is the exact group EAR-229 moved *Genie in the Lamp* out of; the vacated
  ordinal was 1 and nothing closed it.
- Group `019e24a1-b4af-7017-8a4a-cc24a8ba67e9` — 11 games badged 1, 3…12, no 2.

## Root cause

`syncLevelGroupGamesAfterLevelChange` (`internal/core/repositories/level_group.go:599`)
removes membership with a bare
`DELETE FROM level_group_games WHERE game_id = $1` (`:603`) and never renumbers
the source group. The normal removal path `DeleteLevelGroupGame` (`:242-253`)
already does it correctly: `DELETE … RETURNING group_id, sort_order`, then
`UPDATE … SET sort_order = sort_order - 1 WHERE group_id = $1 AND sort_order > $2`.
The sync is simply missing that second statement.

## Change

In `syncLevelGroupGamesAfterLevelChange`, inside the existing transaction:

1. `DELETE FROM level_group_games WHERE game_id = $1 RETURNING group_id, sort_order`
   into locals. `pgx.ErrNoRows` means the game had no membership — not an error,
   skip the backfill and continue to the insert as today.
2. Close the hole in the source group with the same statement
   `DeleteLevelGroupGame` uses.
3. Target-group insert stays exactly as it is: `COALESCE(MAX(sort_order),0)+1`,
   i.e. append to the end.

Nothing else moves. Same transaction as the `games` UPDATE
(`game.go:489` Begin → `:583` Commit), same early-returns for `newLevel <= 0`
and `newLevel > math.MaxInt32`, same orphan behaviour when no target group
matches (the source gap must still be closed in that case — the game leaves its
group and does not join another).

## Explicitly not in scope

- **Choosing a destination position during the move.** Rejected in grilling on
  2026-08-10: it needs new UI on the Game Basic Info page, which is against
  `preserve-ux-design-wire-data-only`, and the Level Group page already has
  drag-reorder for exactly this. The reported symptom is a wrong number, not a
  missing capability.
- **Preserving `sort_order` across the move.** Ordinal 7 in group A means
  nothing in group B; they are separate sequences. Appending is correct.
- **Repairing the existing gaps on staging.** Operator decision 2026-08-10: no
  migration, no one-off SQL. Game replays every embedded migration on every boot
  with no version table (`migrations/run.go:11-13`), so a renormalising
  migration would be a permanent per-deploy cost to fix a one-time mess. The
  next drag-reorder from the Level Group page rewrites the whole set
  (`level_group.go:493`) and clears the gap by itself.
- **Backoffice changes.** The confirm dialog copy in
  `app/composables/useGameLevelGroupMove.ts:130` ("its current position in
  {source} will be lost — reorder it from the Level Group page afterwards")
  stays accurate after this fix: the moved game does lose its position. What
  changes is the ordinals of the games that stayed, which the dialog never
  claimed anything about. One repo, one PR.
- **Optimistic locking / concurrent-edit protection.** Still deferred from
  EAR-229; unchanged by this run.
- **Production.** See Deploy.

## Landmine (carried from EAR-229, still live)

🔴 Do not re-embed `020_sync_game_level_from_level_groups.sql` into the boot
migration runner. It force-realigns `games.level` from `level_groups` and would
drag every moved game back on the next deploy. It is deliberately excluded in
`migrations/run.go:32-34`.

## Acceptance criteria

1. Moving a grouped game to a level owned by another group leaves the source
   group numbered contiguously from 1, and appends the game at the end of the
   target group.
2. Moving a grouped game to a level with no group (orphan case) also leaves the
   source group numbered contiguously.
3. A game that belonged to no group still joins the target group at the end,
   with no error and no stray UPDATE.
4. The renumber commits or rolls back together with the `games` UPDATE.
5. No FE change, no proto/gateway change, no migration.

## Verification

Extend `internal/core/repositories/game_level_group_move_db_test.go` (real
Postgres, gated on `GAME_TEST_DATABASE_URL`; sibling tests
`TestUpdateMovesGameBetweenLevelGroups`, `TestUpdateLeavesGameOrphanWhenNoTargetGroup`,
`TestUpdateJoinsMatchingGroupWhenGameHadNone`,
`TestUpdateRollsBackLevelWhenMembershipSyncFails` already set the pattern).

Per `test-integrity`, the new gap-closing assertions must be **seen failing on
the pre-change code** before the fix lands, and that observation recorded here.

Staging E2E: move a game out of the middle of a group on
`admin-dev.gameslabs.app`, then reload the source group page and confirm the
badges read 1…N with no gap.

## Deploy

Staging only. Production has never received EAR-229, so production cannot
produce this gap — the sync that creates it does not exist there. This run rides
along with EAR-229 in the consolidated production patch later; deploying it
alone to production would change nothing.

## Scope

- Included: `Games-Labs-Game` — `syncLevelGroupGamesAfterLevelChange` plus tests.
- Excluded: everything under "Explicitly not in scope" above.

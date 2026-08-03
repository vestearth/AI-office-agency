# TASK-EAR-196 — Preserve game category on Category Turnover events

## Type

bugfix

## Workstream

backend

## Priority

high

## Created

2026-08-03

## Parent / Epic

Follow-up to TASK-EAR-148 / TASK-EAR-151 — canonical game-classification corrective action.

## Context

Category-scoped Daily and Weekly turnover can remain at zero despite real
non-promotional SLOTS gameplay. `Games-Labs-Game` resolves the canonical
`games.category` while building a round lifecycle, but overwrites that object
with `UpsertRoundSettlement`'s return before publishing `player.activity.v1`.
The repository return projection does not populate `GameCategory`, so the
event omits `game_category`. `Games-Labs-Missions` now correctly matches
category-scoped rules only when both rule and event carry the same non-empty
canonical `game_category`.

This task fixes new settlements and controlled republish paths. It must not
automatically modify historical player progress, replay events, grant rewards,
or change public APIs.

## Goal

Every `turnover.settled` and `round.settled` event emitted by the Game service
for a game with an assigned canonical category carries that category through
the real repository-return path, so existing Missions Category Turnover rules
can score it on both Daily and Weekly surfaces.

## Scope

- Included:
  - Game service category preservation after `UpsertRoundSettlement`.
  - Category hydration for the explicit `RepublishTurnoverSettled` path.
  - Focused regression tests that model the real repository return projection
    and assert the outgoing player-activity payload contains `SLOTS`.
  - Existing Missions matcher parity tests, build/tests, and staging QA plan.
  - A read-only impact/recovery proposal only.
- Excluded:
  - `shared-lib` event contract, protobuf, grpc-gateway, Backoffice UI, and
    public HTTP API changes.
  - Storing a historic category snapshot in `round_lifecycles`; this would be
    a separate schema decision/migration.
  - Automated replays, database backfills, progress edits, or reward credits.

## Acceptance Criteria

- A normal `SettleRound` for a game whose category is `SLOTS` publishes both
  `turnover.settled` and `round.settled` with `game_category=SLOTS`, even when
  the repository-returned lifecycle has an empty `GameCategory`.
- `RepublishTurnoverSettled` emits the category for an existing lifecycle by
  rehydrating it from the canonical game row; no public event/schema change.
- Existing exact category matching remains unchanged: an event with
  `game_category=SLOTS` matches a `SLOTS` Category Turnover rule on Daily and
  Weekly paths; an empty category remains fail-closed.
- Focused Game and Missions tests pass, plus `GOWORK=off go build -mod=readonly
  ./...` in Games-Labs-Game.
- Staging QA records before/after progress from both
  `GET /api/v1/quest/overview?user_id=...` and
  `GET /api/v1/missions/weekly?user_id=...` after one real non-promotional
  SLOTS settlement. User-specific proof requires an authorized test identity.
- A recovery note explicitly rejects raw event replay and describes the need
  for an idempotent per-activity repair only if Product/Operations approves
  historical correction.

## Implementation Plan

1. Re-read the source path and retain the resolved category when processing
   the repository upsert result. Keep the change local to Games-Labs-Game.
2. Ensure the explicit republish flow can derive `GameCategory` from the
   canonical game record. Document that it uses current catalog taxonomy,
   which is acceptable only for the controlled repair path; do not create a
   new persistence field in this incident patch.
3. Add a regression test whose fake repository deliberately returns the same
   shape as the live SQL projection (no category). Capture the published
   events and assert the category survives.
4. Run focused Game tests, existing Missions category-match tests, and the
   Game read-only build. Then deploy Game to staging and perform the stated
   two-surface QA.
5. Audit potentially affected progress without mutation. Daily and Weekly
   idempotency means raw redelivery cannot safely repair missed category
   applications and can double-count other activities; propose a separate,
   ledger-backed repair only after approval.

## Claude Handoff

Read first:

- `Games-Labs-Game/internal/core/services/gamesvc/service.go`
- `Games-Labs-Game/internal/core/repositories/game.go`
- `Games-Labs-Game/internal/core/services/gamesvc/player_activity.go`
- `Games-Labs-Game/internal/core/services/gamesvc/settle_round_test.go`
- `Games-Labs-Missions/internal/services/activity_match.go`
- `Games-Labs-Missions/internal/services/weekly_match.go`
- `ai-dev-office/runs/TASK-EAR-196/pm-output.yaml`

Do not broaden this into a database migration, event-contract change, or a
historical credit operation. If robust historical category snapshots are
required, stop and propose a separate migration task. Before finishing, write
the required `dev-2-output.yaml`, run the validation command, and hand off to
Reviewer rather than declaring a runtime fix without the authorized staging
trace.

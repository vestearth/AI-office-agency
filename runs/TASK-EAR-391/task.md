# TASK-EAR-391: Missions: unearned claim on admin CATEGORY_TURNOVER / ANY_GAME_TURNOVER events

Owner: Games-Labs-Missions. Found during TASK-EAR-387 (2026-10-10). Money path.

## Defect

Admin-created events whose only condition is `CATEGORY_TURNOVER` or
`ANY_GAME_TURNOVER` can be claimed by any player with no join and no turnover.

- `internal/services/event_admin.go` `validateEventRequest` (~L160-161) stores
  every admin event with `ProgressSource: ""` and `TargetValue: 0`. These two
  types need no `game_ids`, so they are saved with no `mission_event_games` rows.
- `internal/services/event_service.go` `buildCard` (~L508): SPEND_PROP goes to
  the spend branch, `cfg.IsConfigDriven()` (`len(cfg.Games) > 0`) goes to the
  join-gated branch. Everything else falls to the legacy `progress_source` path:
  progress stays 0 because `ProgressSource` is empty, `eligible = state == "active"`,
  and `Claimable = eligible && 0 >= 0 && !claimed` is **true**. No join check.
- `ClaimMissionEvent` (~L369) trusts `card.Claimable` and credits the wallet.
- `internal/models/event.go` L11-13 says these two types "remain stored config
  only": no runtime progress exists for them at all.

Same code on origin/staging (1d67353) and origin/prod (9dcd5fb): `git diff
origin/prod origin/staging` on the three files is empty. The admin create path
landed 2026-07-03 (3d7a818, TASK-EAR-064).

## Evidence

- `evidence/ev-001-red-test.log`: RED test on origin/staging 1d67353. Both
  subtests fail with `Joined:false Progress:0 Target:0 Claimable:true`. A probe
  variant without the card check showed `ClaimMissionEvent` returns nil (claimed,
  wallet credited). The test file is `evidence/red-test-event_unprogressed_claim_test.go.txt`
  (place it at `internal/services/event_unprogressed_claim_test.go`; it uses the
  `configEventRepo` fake from `event_missions_v11_test.go`).
- `evidence/ev-002-staging-admin-read.log`: staging event `play-by-game-5470cb66`
  is CATEGORY_TURNOVER {MINIGAME, min_turnover 3000}, `game_ids` null, target 0,
  100 POINT reward, 200 POINT claimed (2 claims), and the report flags claims with
  no join record.
- `evidence/ev-003-prod-exposure.log`: prod runtime and log census.

## Decision: option A, refuse until tracked (operator, 2026-10-10)

This task does not add turnover progress for CATEGORY_TURNOVER / ANY_GAME_TURNOVER.
Progress tracking for those types is a separate future task.

### Runtime guard (required, this closes the money hole)

`internal/services/event_service.go` `buildCard`: the legacy `progress_source`
branch serves only configs with `len(cfg.Conditions) == 0` (the seed
`event_daily_mission_sprint`). Any other config that is neither SPEND_PROP nor
config-driven (`len(cfg.Games) > 0`) returns a card with `Eligible: false`,
`Claimable: false`, `Target: 0`, `Progress: 0` (still listed, never claimable).
`ClaimMissionEvent` then returns `ErrMissionEventNotClaimable` with no wallet call.
Do not branch on the type names: an unknown or future condition type must also land
in the refused branch.

### Admin guard

`internal/services/event_admin.go`:
- `validateEventRequest`: reject a request with a CATEGORY_TURNOVER or
  ANY_GAME_TURNOVER condition with `ErrInvalidInput` ("condition type X has no
  progress tracking yet"). This covers create and update (400).
- `SetEventActiveAdmin(active=true)`: reject with `ErrInvalidInput` when the stored
  event has such a condition, so existing staging events cannot be reactivated.
  Deactivating and deleting stay allowed.
- `validEventConditionType` keeps accepting the names, so stored rows still read back.

### Tests (RED first, per test-integrity rule)

- `evidence/red-test-event_unprogressed_claim_test.go.txt`, already seen failing on
  origin/staging 1d67353 (ev-001). Must pass after the fix.
- Add cases: unknown condition type with no games is not claimable; admin create and
  update with each type return ErrInvalidInput; SetEventActiveAdmin(true) on a stored
  CATEGORY_TURNOVER event returns ErrInvalidInput and (false) still works.
- `TestLegacySeedEventStillListsAndClaims` and every existing GAME_TURNOVER /
  SPEND_PROP test stay green unchanged.

### Impact

- Mobile: these events show up as not eligible and not claimable. No contract change.
- Backoffice: the event create form still offers both types and will now get a 400.
  Follow-up for the Backoffice owner: hide or disable those options and show the
  server message. Not in this task; record it in the dev output.
- No migration. No shared-lib change. PR to `staging`. Prod is cost-gated: the fix
  reaches prod only through a separately approved prod train.

## Open checks

1. **Staging claimants (unverified).** Who are the 2 claimants of
   `play-by-game-5470cb66`, did they join, and did they have >= 3000 MINIGAME
   turnover between 2026-08-07 and 08-31? Query on the staging Missions DB:
   `SELECT user_id, created_at FROM mission_logs WHERE mission_type='event_reward'
   AND reference_id='play-by-game-5470cb66';` then `mission_event_participants` for the
   join and Game round turnover for the window. The defect stands either way: the
   service never measured that turnover.
2. **Prod claims (gate prod_claim_census, cost-gated).** Prod Missions is desired 0
   and RDS is not readable by `vestearth`. Counting real claims needs the prod DB:
   list events with `CATEGORY_TURNOVER` / `ANY_GAME_TURNOVER` conditions and no
   `mission_event_games` rows, then `event_reward` claims per event. Needs the
   operator to approve running prod or to run the query.

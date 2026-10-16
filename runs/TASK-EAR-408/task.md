# TASK-EAR-408: Missions: Mission Boost checks a literal 'mission_boost' pass type (may never see a canonical Point Multiplier pass)

- Type: bugfix candidate / investigation (Games-Labs-Missions)
- Repo: Games-Labs-Missions
- Created: 2026-10-17 by the Claude conductor lane at operator request. Claude opens
  this run only; investigation and any fix go to another lane.
- Gates: preset `staging`. A confirmed fix reaches production on a release train
  (production is cost-gated; see AGENTS.md).
- Source: Knowledge Librarian audit `knowledge-reviews/20261016T082044Z-weekly-recheck.yaml`,
  finding `games-labs-missions:mission-boost:literal-pass-type-lookup` (status new,
  evidence partial). The librarian called it "a lead for a developer, not a confirmed bug".

## Suspicion (source only, nothing observed at runtime)

All on Games-Labs-Missions `origin/staging@5ef7558`:

- `internal/services/mission_service.go:544` and `:2016` check the pass with
  `s.hasPass(userID, "mission_boost")`: Mission Boost status and claim.
- `internal/services/store_service.go:791-800` `HasActivePass` passes that string to
  `repo.GetUserPass(userID, passType)` **without** `NormalizePassType`.
- `internal/repositories/store_repo.go:78-97` `GetUserPass` matches
  `WHERE user_id = $1 AND pass_type = $2` (literal).
- Level progression reads the canonical type instead:
  `store_repo.go:650-660` `MaxActivePointMultiplier` queries `'point_multiplier'`.
- `internal/models/pass_type.go:11-27,39-93` (TASK-EAR-247) defines the canonical types
  (`level_access`, `point_multiplier`) and their aliases (`mission_boost` among them).
- The vault's Missions Workflow Map says both sides of any pass-type comparison must be
  normalized.

If the purchase or grant path now stores `point_multiplier`, then
`GET /api/v1/missions/boost/status` would report `has_pass=false` for a player who holds an
active Point Multiplier pass, and the Mission Boost claim would refuse them.

## Scope

1. Trace the write side: which `pass_type` string the store purchase / admin grant paths
   write to `user_passes` today, and which strings exist in staging data. Read-only SQL is
   fine; record counts only.
2. Confirm or refute on staging: a player with an active Point Multiplier pass calls
   `GET /api/v1/missions/boost/status` (and the claim path, if safe on a test account).
3. If confirmed: normalize the lookup (`HasActivePass` / `GetUserPass` through
   `NormalizePassType`, or query canonical plus aliases). Keep legacy rows working. Check the
   other `hasPass(…)` call sites for the same pattern (defect class).
4. If refuted: record why (the write side still stores the alias, for example), close the
   run, and point the librarian finding at the evidence.

## Acceptance

- Bug confirmed or refuted with evidence: source lines on the deployed commit, a staging
  request/response, and the `user_passes` pass_type distribution as counts only.
- If fixed: a regression test seen failing first (a canonical `point_multiplier` pass makes
  Mission Boost status `has_pass=true`; a legacy `mission_boost` row still does), the full
  suite green, a staging deploy and a staging smoke on a test account.
- No schema change expected. If a data backfill seems needed, stop and ask: it needs its
  own decision and migration rules.

## Evidence handling

No player identifiers or tokens in the run. Test accounts only, counts for data.

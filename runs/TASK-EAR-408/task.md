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

## Findings 2026-10-20 (Claude conductor lane, read-only)

Source confirms the suspicion on **both** Missions `origin/staging@5ef7558` and `origin/prod@9dcd5fb`
(the lookup lines are identical), with Order `origin/staging@46c608b` / `origin/prod@aedf982`:

- **Write side is canonical.** Order only accepts `pass_type` `level_access` / `point_multiplier`
  (`internal/models/special_item.go:72`), and Order migration `035_canonical_pass_type_slugs.sql`
  (on prod since 2026-08-10) rewrote catalog rows, including `mission_boost`, to `point_multiplier`.
  The "Mission Boost (Weekly)" catalog item (`a4a66458-…`, alias `mission_boost_weekly`, Order
  migration 026) therefore carries `point_multiplier`. Missions purchase stores `item.PassType`
  unchanged (`store_service.go:977` → `store_repo.go:397-460` `CompletePassPurchase`).
- Missions migration `053_user_passes_per_item.sql` (on prod since 2026-08-11, replayed every boot)
  rewrites every `user_passes` row that has a `canonical_item_id` from `mission_boost` (and other
  aliases) to `point_multiplier`.
- **Read side is literal.** `mission_service.go:544` (claim) and `:2016` (status) call
  `hasPass(userID, "mission_boost")` → `StoreService.HasActivePass` (`store_service.go:791`) →
  `GetUserPass` `WHERE pass_type = $2` (`store_repo.go:78-97`), no normalization.
- Effect if Mission Boost is live: a player who bought a Point Multiplier / Mission Boost pass
  through the canonical store gets `has_pass=false` on `GET /api/v1/missions/boost/status`, and the
  claim pays `cfg.NormalReward` (`mission_boost_normal`) instead of `cfg.PassReward`. Only legacy
  rows with no canonical item id (e.g. an admin `give-pass` with `pass_type=mission_boost`) still
  match. This is an underpayment on a money path, not an overpayment.
- Same defect class, other literal lookups through `HasActivePass` / `GetUserPass` (Missions staging):
  `store_service.go:1543` `HasActivePass(userID, "coin_booster")` (exchange +10% coin bonus — also an
  alias of `point_multiplier`, so it misses canonical rows too); `store_service.go:1386` `grantPass`
  extends an existing pass by literal type; gRPC `HasActivePass` (`mission/grpc/server.go:422`)
  passes the caller's string through. Games-Labs-Game has the gRPC client port but no non-test
  caller on `origin/staging`. Whether `coin_booster` should mean `point_multiplier` is a product
  question — flag it, do not assume.

Not yet shown (needs the operator's DB access; Claude has no direct staging DB lane):
`user_passes` pass_type distribution and the count of active `point_multiplier` holders the
lookup misses — SQL in `evidence/user-passes-pass-type-counts.sql` (counts only). A staging
request on a test account holding a canonical Point Multiplier pass would close scope item 2.

Fix direction (for the implementing lane, not done here): make `HasActivePass` /
`GetUserPass` compare normalized types (`models.NormalizePassType` on the argument and a
canonical-plus-aliases match on the column), with a RED test: a canonical `point_multiplier`
row makes Mission Boost `has_pass=true`; a legacy `mission_boost` row still does. No schema
change or backfill needed — 053 already canonicalizes rows.

### Staging data, 2026-10-20 08:01Z (ev-001, operator-run DBeaver, counts only)

- **Write side confirmed:** every row with a canonical item id is canonical — `point_multiplier`
  13 rows / 8 users, `level_access` 10 rows / 7 users. There are **zero** `mission_boost` rows of
  any kind. Legacy rows without a canonical id (`Point Multiplier`, `bonus_2x`, `golden_pass`,
  2× `point_multiplier`) are all inactive.
- So on staging the literal `hasPass(userID, "mission_boost")` cannot return true for anyone, and
  never could for the 8 users who held a canonical Point Multiplier pass while it was active.
- **No current impact on staging:** no `point_multiplier` pass is active now (Q2 = 0), so nobody
  is being mis-served today. This neither confirms nor refutes the lookup defect at runtime.
- Still open for scope item 2: a staging request from a test account that holds an **active**
  canonical Point Multiplier pass (`GET /api/v1/missions/boost/status` expected `has_pass=false`
  under the bug). That needs a pass purchase or grant on a test account (a staging write).
- Prod counts not taken (prod is cost-gated; operator's call).

## Handoff to dev — 2026-10-20 (operator decision)

Operator: source + staging data are enough; no pre-fix runtime repro. Investigation (scope 1)
is closed as **confirmed by source**; the runtime check moves into `staging_acceptance`.

Implement on Games-Labs-Missions (branch from `origin/staging`):

1. **RED first** (`internal/services` or `internal/repositories` test, whichever reaches the real
   lookup): a user with an active `point_multiplier` row that has a canonical item id must make
   `HasActivePass(userID, "mission_boost")` true and Mission Boost status `HasPass=true`; a legacy
   `mission_boost` row (no canonical id) must still be true; an expired / inactive row false.
   Record the failing run as evidence before the fix (test-integrity rule).
2. **Fix:** compare normalized types in `StoreService.HasActivePass` → `StoreRepository.GetUserPass`
   (`models.NormalizePassType` on the argument, and match the column against the canonical slug
   plus its aliases, e.g. build the alias list from `models` rather than hard-coding SQL). Keep
   `ORDER BY active DESC, expires_at DESC`. `grantPass` (`store_service.go:1386`) uses the same
   lookup — check its extend-expiry behaviour still holds with the normalized match.
3. **Defect class, decide don't assume:** `store_service.go:1543` `HasActivePass(userID,
   "coin_booster")` (+10% exchange coin) becomes true for every `point_multiplier` holder once
   lookups normalize, because `coin_booster` is an alias of `point_multiplier`. That is a money
   behaviour change: either keep coin_booster literal (separate exact-match path) or get the
   operator's yes before widening it. Say which in the dev output.
4. No schema change, no backfill (migration 053 already canonicalizes rows with a canonical id).
5. Full suite + `go vet` green; open the PR, no merge without review.

`staging_acceptance` (after deploy): a **test account** holding an active canonical Point
Multiplier pass calls `GET /api/v1/missions/boost/status` → `has_pass=true`; a non-holder →
`false`. No player identifiers in evidence.

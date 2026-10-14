# TASK-EAR-390 — Per-player provider turnover for the monitoring report

Parent: TASK-EAR-291. Owner: Games-Labs-Logs.

## Problem

The player report Provider tab says provider turnover is not available. The
provider report list is a catalog with round measures still unpublished.
Round outcomes used by the game report carry `game_id`, not a provider total
per user.

## Outcome

The Provider tab lists that player's turnover grouped by provider. A provider
with no captured rounds is absent, not a zero row invented from the catalog.
The unavailable message is gone.

## Scope

- `Games-Labs-Logs` owns the aggregate over settled rounds.
- Use a provider identity the round event or the existing game catalog already
  has. Do not invent one.
- `shared-lib` holds the new read if none exists. Publish before the consumer bump.
- `api-gateway` follows the module bump.
- `Games-Labs-backoffice` binds the Provider tab on
  `app/pages/admin/monitoring/report/player/[id].vue`.
- `Games-Labs-Game` is a read of the existing catalog only, unless the round
  event has no provider identity at all.

## Acceptance

- The tab shows provider rows for that player from Logs.
- Turnover is absent when the round projection cannot produce it, not zero.
- The unavailable copy on the Provider tab is gone.
- An authenticated admin-dev read of one player with captured rounds matches the API.

## Implementation plan (Claude lane, 2026-10-12)

Read-only investigation of the deployed branches (Logs/Game/gateway
`staging`, shared-lib/backoffice `main`). Key facts were re-checked by hand.

**No provider identity exists on the round path today.** The Logs projection
`monitoring_round_outcomes` (`infrastructures/monitoring_clickhouse.go:184-198`)
has no provider column; `events.PlayerActivityEvent` has no provider field;
Game's `buildRoundActivityEvent` (`internal/core/services/gamesvc/player_activity.go:125-139`)
sends the platform game UUID but drops the `game.ProviderID` it already
resolved. The "unless the round event has no provider identity" clause
therefore applies: Game publishes the provider id. A query-time join is not
workable: Logs has no Game client, admin ListGames requires staff metadata,
and the player reads hide inactive games/providers.

**Change order**

1. shared-lib: `PlayerActivityEvent.ProviderID string json:"provider_id,omitempty"`
   and `ReportsService.ListPlayerReportProviders`,
   `GET /api/v1/admin/reports/player/{entity_id}/providers` (entity_id=1,
   from=2, to=3). Response: status=1, items=2, coverage_start=3,
   partial_data=4, partial_data_reason=5, int64 unattributed_rounds=6. Item:
   provider_id=1, int64 total_rounds=2, optional double turnover_coin=3,
   optional double wl_coin=4. No route collision (ends in literal
   `providers`); append the RPC last. Publish first.
2. Game: bump, copy `game.ProviderID` onto all three round events (settled,
   outcome_updated, reversed). All three are required: the ReplacingMergeTree
   replaces whole rows, so a blank provider on a later event would wipe it.
   Re-read the provider when the stored game id differs from the request (the
   `gameCategoryByID` path).
3. Logs: bump; `ALTER TABLE ... ADD COLUMN IF NOT EXISTS provider_id
   LowCardinality(String) AFTER game_id` in the boot DDL loop (`:102-117`);
   insert at `:299`; the read groups settled (`reversed = 0`) rounds of one
   user by provider_id, unpaged; rounds with a blank provider count into
   `unattributed_rounds`, never a zero row. Coin turnover/W-L follow the game
   report header rule (absent when any round has a blank currency). Scan
   `toInt64(count())` into int64; real-driver tests only.
4. api-gateway: bump plus route test (ReportsService already registered at
   `gateway/grpc.go:163`).
5. backoffice: `PlayerReportProviderTab.vue` already exists with mock rows
   ("(Mock)" at :78). Wire real data into that designed component; names from
   the existing `/api/v1/admin/provider` list; Total (THB) stays "-"; RTP only
   when both coin values exist. Remove the unavailable copy at
   `report/player/[id].vue:90-96`.
6. Operator, optional: one-off backfill
   `ALTER TABLE monitoring_round_outcomes UPDATE provider_id = transform(game_id, [...], [...], '') WHERE provider_id = ''`
   from a Game `games.id -> provider_id` export; safe to re-run.

**RED tests**

- shared-lib: HTTP rule of the new RPC; presence of turnover_coin/wl_coin.
- Game: all three round events carry the resolved provider id, including a
  retry whose stored game differs.
- Logs (real ClickHouse via MONITORING_TEST_CLICKHOUSE_ADDR): boot twice; two
  providers returned and a catalog provider with no rounds absent; reversed
  excluded; turnover_coin nil when any round has a blank currency; blank
  provider rounds counted in unattributed_rounds.
- gateway: the path reaches the new RPC, not drilldown/GetReport; absent
  turnoverCoin not emitted as 0.
- backoffice: flip `tests/playerReportUnavailableStates.test.mjs`, no "(Mock)".

**Open questions for the operator**

1. Should Game set `Currency = "COIN"` on round events (a separate task)?
   Every staging round has a blank currency today, so turnover/W-L stay "-"
   on the Provider tab until it does; only round counts show.
2. Run the provider backfill, or attribute from deploy time only?
3. Group by provider UUID with names resolved in the backoffice: acceptable?

## Operator decisions (2026-10-12) — contract can be frozen

1. **Round currency is in scope here.** Game sets `Currency = "COIN"` on the
   round events (settled, outcome_updated, reversed) together with the
   provider id, so turnover and W/L can be produced. Before coding, confirm
   from Game source that every settled round is a COIN round (promotional or
   point rounds included); if any is not, stop and report rather than stamping
   COIN on it. Side effect to state in the PR and verify on staging: the Game
   report Coin cards and per-game turnover start showing values for rounds
   settled after the deploy, instead of "-" (older rounds keep a blank
   currency, so a filter spanning both stays absent per the existing rule).
2. **No backfill.** Provider attribution starts at deploy; earlier rounds have
   a blank provider and are counted in `unattributed_rounds`, never as a zero
   row or a guessed provider. Drop step 6 of the plan.
3. **Group by provider UUID**; the backoffice resolves names from the existing
   `/api/v1/admin/provider` list. Logs stores no provider name.

## Operator decision 2 (2026-10-12) — option (a), supersedes decision 1 above

dev-2's precondition check failed: not every round is COIN (Sigma arcade
settles without a COIN wallet movement and defaults to THB; GGSoft forwards
other currencies). So **this run does not stamp any currency.** Ship provider
attribution only: shared-lib `PlayerActivityEvent.ProviderID` + the
`ListPlayerReportProviders` read, Game publishes `provider_id` on all three
round events, Logs adds the column and read, gateway bump, backoffice binds
the Provider tab. With a blank currency the tab shows **round counts per
provider; turnover and W/L stay absent ("-")**, which is the correct
"absent, not zero" behaviour. No backfill (decision 1.2 stands). The real
per-round currency is TASK-EAR-405.

## Operator decision 3 (2026-10-14)

dev-2 noted that Game does not persist `provider_id` on `round_lifecycles`, so a
later correction or replay attributes a round to the game's provider at that
time. **Accepted as is**: a game's provider does not change. No migration.

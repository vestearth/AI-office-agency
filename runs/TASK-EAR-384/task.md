# TASK-EAR-384: Profile Statistics — one top game per category

## Context

- Operator request (2026-10-07): assess the App team's Home/Profile API request and open separate tasks when appropriate. This run is planning only; implementation, commit, PR and deployment are later phases.
- The Profile screenshot shows Slots / Arcade / Table / Card, each with a Top Performance game, Max Coin Win and Total Wins. The Android reference currently renders placeholder assets in `feature/profile/ui/components/ProfileStatisticsSection.kt`.
- Game already owns the underlying round history and win aggregates. `ListPlayerGameActivity` in `Games-Labs-Game/internal/core/repositories/game.go` computes `MAX(win_amount)`, positive-payout round count and non-NULL captured-round count, excluding reversed rounds. The existing admin API is not a player-facing endpoint and does not select one winner within every category.
- There are two distinct category models: canonical `game_categories` (code PK, referenced by `games.category`) and curated Mobile `categories` / `category_games` (UUID grouping). Migration 030 seeds SLOTS / CRASH / ARCADE / MINIGAME / CARD, without TABLE; current runtime rows were not queried. Do not equate these models or invent a TABLE mapping.

## Goal

Provide an authenticated Profile Statistics endpoint returning at most one top game per agreed category, using Game-owned win semantics and honest capture coverage.

## Scope and ownership

| Repository | Allowed changes |
| --- | --- |
| `shared-lib` | `proto/gamepb/game.proto`, its generated protobuf/gRPC/gateway/OpenAPI artifacts, contract tests and API examples |
| `Games-Labs-Game` | `internal/models/`, `internal/core/ports/`, Game repository/service/gRPC handler and focused tests; `go.mod` + `go.sum`; README/API examples |
| `api-gateway` | Published shared-lib dependency bump, generated-route registration/identity/serialization tests and API/Postman docs |

Game is the data owner even if the public URL is under `/users/me`. The proposed HTTP annotation can belong to `gamepb.GameService`; no User-service implementation or cross-service database read is required.

Out of scope: Android writes, Backoffice changes, provider payout/capture changes, win-history backfill, currency conversion, Wallet/User schemas, adding a new category automatically, production compute/RDS startup, and unrelated task/status edits.

## Proposed API contract

- `GET /api/v1/users/me/game-statistics`, mapped to a new GameService RPC. Derive identity exclusively from trusted authenticated caller metadata; no user selector in request/query/body.
- Preserve the standard `status` envelope; use a `data` list of category entries with game ID, localized/fallback game name, public image URL, optional `maxCoinWin`, `totalWins`, and `capturedRounds`. Include existing `roundsPlayed` as coverage context if agreed at the contract gate.
- Prefer canonical `categoryKey` (e.g. `SLOTS`) plus `categoryName` for genre statistics. A canonical category has a code identity, not a UUID `categoryId`. If Product instead needs curated Mobile categories, use their actual UUIDs and explicitly define membership/key mapping. Final shape must be recorded before proto editing; never fabricate IDs or derive stable keys from translated labels.
- Top Performance rule (locked below): highest captured `maxCoinWin` per game within each canonical category; ties by `roundsPlayed DESC`, then canonical game UUID ascending. Category order is `game_categories.sort_order`, then `code`.
- `maxCoinWin` means maximum gross payout/total return credited in platform coin major units, not net profit. `totalWins` counts non-reversed rounds with `win_amount > 0`. `capturedRounds` counts non-reversed rounds with non-NULL `win_amount`, including confirmed zero payouts. These are existing definitions, not new win rules.
- History is limited to available captured providers/rounds; do not describe it as complete lifetime statistics. Preserve missing win presence: no capture is unavailable, while captured zero is a valid zero. Document int64 fields as protobuf JSON strings and `maxCoinWin` as a number when present. An omitted `maxCoinWin` must not be rendered as `0`.
- Empty-state behavior (locked below): include every active canonical category in sort order; no played game means no `topGame` message. Where history exists but the selected game has no win capture, keep `topGame` and omit `maxCoinWin`.
- Personal history includes games the caller played even if the catalog row is later inactive, pending, or in maintenance. This is intentionally wider than admin `ListPlayerGameActivity`, which keeps only `status = active`.

## Locked contract (operator, 2026-10-07)

Provenance: operator request on this task to clear Top Performance and the Table category, checked against current source. No proto edit in this pass. Runtime category rows were not queried.

### 1. Top Performance

Inside one category, exactly one game wins:

1. Highest captured `maxCoinWin` (`MAX(win_amount)` over non-reversed rounds). A game with no captured win sorts after every game that has one. NULL is not zero.
2. Tie: `roundsPlayed DESC` (count of non-reversed rounds).
3. Tie: canonical game UUID ascending.

Admin Top Performance uses the same first two keys, then `g.name ASC` (`Games-Labs-Game/internal/core/repositories/game.go`, `PlayerGameActivitySortTopPerformance`). Profile uses the UUID as the third key so a rename cannot change the winner.

| Field | Meaning |
| --- | --- |
| `maxCoinWin` | Gross payout / total return, platform coin major units. Absent when no non-reversed round has a non-NULL `win_amount`. Present `0` is a confirmed zero payout. |
| `totalWins` | Non-reversed rounds with `win_amount > 0` (TASK-EAR-183 Option A). Not a sum of money. |
| `capturedRounds` | Non-reversed rounds with non-NULL `win_amount`, including confirmed zeros. |
| `roundsPlayed` | Non-reversed rounds, captured or not. Coverage context and the second ranking key. |

Reversed rounds are excluded from every count and from the max. `capturedRounds < roundsPlayed` means partial capture, not a lifetime total.

### 2. Table is not a category

Statistics use canonical `game_categories.code` (`games.category` FK). They do not use curated Mobile `categories` / `category_games` UUIDs, and they do not use the four Profile screenshot labels as a closed set.

Seeded codes in `migrations/030_create_game_categories_table.sql`: `SLOTS`, `CRASH`, `ARCADE`, `MINIGAME`, `CARD`. There is no `TABLE` row. Android Profile renders a static label `profile_statistics_table` ("Table") on a placeholder image (`ProfileStatisticsSection.kt`). Home `GameCategoryDestination` maps Slot, Arcade, Crash, and Mini Game only. `CARD` is a separate seeded code; it is not Table. The 2026-07-18 audit cited in migration 030 had zero active CARD games; that does not create a Table mapping.

The endpoint returns active `game_categories` rows in `sort_order`, then `code`. It must not emit `categoryKey: "TABLE"` unless that code exists as a real row. It must not alias Table to `CRASH`, `MINIGAME`, `CARD`, or any other code. A later admin insert of a real code, including `TABLE`, would appear because it is data. Creating that row is a separate taxonomy change, not part of this endpoint.

### 3. Selection, empty history, and inactive games

- Every active canonical category is returned in order. The caller having no non-reversed round in that category leaves `top_game` unset. Gateway JSON renders that as `topGame: null`.
- Inactive category rows are omitted.
- Selection scans all qualifying rounds for that caller and category. It is not the admin activity page regrouped on the client.
- A game stays eligible after it leaves `active` (inactive, pending, or maintenance) when the caller has non-reversed rounds on it.
- If rounds exist but the selected game has no captured win: `topGame` is present, `maxCoinWin` is omitted, `totalWins` is `"0"`, `capturedRounds` is `"0"`. That zero count means no positive captured payout. It is not a measured max win of zero.
- Confirmed all-zero capture: `maxCoinWin` is the JSON number `0`, `capturedRounds` equals the captured count, and `capturedRounds` may still be below `roundsPlayed`.
- Missing image is `imageUrl: ""`. Name is `display_name`, falling back to `name`, matching the admin `COALESCE`.
- Identity comes only from the trusted authenticated caller. A client-supplied user id cannot select another player.

`int64` fields are protobuf JSON strings. `maxCoinWin` is a JSON number only when present, and stays omitted when unset, including under gateway `EmitUnpopulated`. An unset `topGame` is JSON `null` on that same gateway, because an unset message is emitted as null. Clients treat `null` as no top game.

### JSON examples

Played Slots with partial capture, Crash never played. No Table entry.

```json
{
  "status": {"code": 200, "description": "OK"},
  "data": [
    {
      "categoryKey": "SLOTS",
      "categoryName": "Slots",
      "sortOrder": 1,
      "topGame": {
        "gameId": "6f1c2a40-0000-4000-8000-000000000001",
        "gameName": "Egypt Cat",
        "imageUrl": "https://cdn.example/games/egypt-cat.png",
        "maxCoinWin": 120.5,
        "totalWins": "4",
        "capturedRounds": "6",
        "roundsPlayed": "10"
      }
    },
    {
      "categoryKey": "CRASH",
      "categoryName": "Crash",
      "sortOrder": 2,
      "topGame": null
    }
  ]
}
```

Rounds exist, win never captured. `maxCoinWin` is absent on purpose.

```json
{
  "categoryKey": "ARCADE",
  "categoryName": "Arcade",
  "sortOrder": 3,
  "topGame": {
    "gameId": "6f1c2a40-0000-4000-8000-000000000002",
    "gameName": "Arcade One",
    "imageUrl": "",
    "totalWins": "0",
    "capturedRounds": "0",
    "roundsPlayed": "3"
  }
}
```

Every captured round paid zero. `maxCoinWin` is present `0`.

```json
{
  "categoryKey": "CARD",
  "categoryName": "Card",
  "sortOrder": 5,
  "topGame": {
    "gameId": "6f1c2a40-0000-4000-8000-000000000003",
    "gameName": "Card One",
    "imageUrl": "https://cdn.example/games/card-one.png",
    "maxCoinWin": 0,
    "totalWins": "0",
    "capturedRounds": "5",
    "roundsPlayed": "5"
  }
}
```

## Acceptance Criteria

- [x] Ranking, canonical taxonomy (Table is not a code), empty/history behavior, and JSON examples are recorded in **Locked contract (operator, 2026-10-07)** before proto changes.
- [ ] Authenticated GET returns only the caller's data; missing identity and forged identity metadata are rejected using existing structured errors. No client-supplied ID can select another player's statistics.
- [ ] Fixture data spanning multiple games per category returns exactly the agreed top game per category with deterministic ties. Selection runs across all qualifying records, not a globally limited page of admin results.
- [ ] Metrics reuse the existing gross-payout definitions, exclude reversed rounds, and keep confirmed zero distinct from unknown capture. Mixed captured/uncaptured history does not imply complete lifetime totals.
- [ ] No-played, no-capture, partial-capture, empty category, inactive game/provider, and missing image/name cases match the frozen contract without fabricated games, category IDs or wins.
- [ ] Shared-lib adds the contract without renumbering existing fields, regenerates artifacts through its existing tooling, and passes the relevant compatibility checks.
- [ ] After the operator publishes shared-lib, Game and gateway adopt the same version; `go.mod`/`go.sum` are tidied together with no local `replace`. Focused tests, applicable full Go suites, `GOWORK=off go build -mod=readonly ./...` and lint/vet pass or have a specific valid skip reason.
- [ ] Authenticated staging gateway acceptance reconciles fixture rounds with response metrics and verifies the actual JSON presence, number/string types, identity isolation and public image URLs. Source/CI/deploy registration alone does not satisfy this criterion.
- [ ] Docs/Postman and App handoff describe the final route, ranking, taxonomy, units, capture limitations, errors, empty states and refresh behavior. Android integration is handed to the human Mobile team.

## Technical plan and sequencing

1. `dev-2`: resolve and record the contract decisions with App/Product; re-read current source/branches. Reuse the Game aggregate semantics, with a category-partitioned query rather than fetching a top-N admin page and grouping on the client.
2. `dev-2`: update GameService proto first, regenerate and verify shared-lib. Stop at the workspace's explicit operator publication/version gate; do not implement downstream replacements or local contract copies.
3. `dev-2`: after publication, bump Game, implement caller-scoped aggregation and mapping, and add focused repository/handler tests. No new schema is expected for the canonical-category option.
4. `dev-2`: bump gateway to the same shared-lib version, verify generated route and trusted identity/JSON serialization, then update handoff examples.
5. Independent review and authenticated staging acceptance before completion. Game/gateway PR targets are `staging`; shared-lib target is `main`. Inspect workflows and verify remote PR targets before publication.

Both this task and the companion Game Favorites task touch `gamepb` generated files, Game handlers/ports and consumer module pins. Serialize those shared-file changes; neither task depends on the other's feature completion.

## Risks and verification boundaries

- Current Game query is an admin/global-per-game page: using it unchanged cannot guarantee one top game in every category.
- Canonical genre and curated display grouping are not interchangeable; Table has no mapping proved by the inspected source.
- Unknown capture is not zero. Existing capture tests are reference evidence, not tests run for this new feature.
- Runtime category contents, deployed endpoint support and authenticated staging behavior were not inspected in this planning session.

## Source evidence (inspected 2026-10-07)

- Game checkout: `staging`, HEAD `5525204`; `internal/core/repositories/game.go:222` (`ListPlayerGameActivity`) and `internal/models/game.go` (`PlayerGameActivity`, `RoundLifecycle`).
- `Games-Labs-Game/internal/core/repositories/round_win_amount_db_test.go:221`: existing win, NULL/zero, reversal, sorting fixtures; inspected, not executed.
- `Games-Labs-Game/migrations/030_create_game_categories_table.sql`, `031_games_category_fk.sql`, and `internal/models/game_category.go`: canonical category ownership.
- `Games-Labs-Game/migrations/010_create_categories_table.sql`, `011_category_games_category_id.sql`: separate curated category identities.
- shared-lib checkout HEAD `4bcb80c`; `proto/gamepb/game.proto` has existing public lists but no Profile Statistics RPC. api-gateway checkout HEAD `54d25e9`; `gateway/grpc.go` registers Game and uses camelCase proto JSON with EmitUnpopulated.
- `api-gateway/gateway/http.go:105`, `middleware/identity_headers.go` and gateway identity tests: authenticated routing/trusted subject forwarding to reuse and test.
- Android `DevGameService.kt` and `ProfileStatisticsSection.kt` are read-only comparison references.
- SocratiCode primary `d:\llm` resolved to the local workspace. Explicit local status was green/manual; query `ListPlayerGameActivity max_coin_win captured_rounds` located the existing aggregate tests and win definition. Actual source files above were the planning proof.
- Exact endpoint/favorites and naming-variant searches across Game, shared-lib proto, gateway and existing `runs/*/task.md` found no matching existing player feature task to reuse.


## Display-name fallback follow-up verification (2026-10-07)

- Independently inspected `task/TASK-EAR-384-display-name-fallback`, based on Game HEAD `5464cc4325297bc4411f577761de36169fb02996`. The working tree has only `internal/core/repositories/game.go` and `internal/core/repositories/player_game_statistics_db_test.go` modified. The fix is still uncommitted.
- Statistics now select `COALESCE(NULLIF(TRIM(g.display_name), ''), g.name)`. Existing regression fixtures verify both empty and space-only display names against their stored game names.
- Reproduced the regression against real disposable PostgreSQL 16: a temporary Go source overlay restored only the old `COALESCE(g.display_name, g.name)` expression. `go test -mod=readonly -count=1 -run TestListPlayerGameStatistics/blank_display_name -v ./internal/core/repositories` failed with an empty `GameName` where `Stored Name` was expected. The same test passed with the working-tree fix, including the space-only assertion. The tracked source was not rewritten for this check.
- `GOWORK=off go test -mod=readonly -count=1 ./...` passed with `GAME_TEST_DATABASE_URL` pointing exclusively at the disposable local database. The full suite ran, including DB-backed repository tests; the separate schema-drift suite requires `GAME_MIGRATIONS_TEST_DATABASE_URL` and was not enabled.
- `GOWORK=off go build -mod=readonly ./...` and `GOWORK=off go vet -mod=readonly ./...` passed.
- Fresh GitHub/ECS reads verified Game staging HEAD `5464cc4`, Deploy STAGING run `37620033459` successful, task definition `games-labs-game-staging:75`, image `staging-sha-5464cc4`, desired/running `1/1`, task/container `HEALTHY`, rollout `COMPLETED`. Gateway Deploy STAGING run `37620012820` was successful at `e375321`, with revision `126`, matching image, desired/running `1/1`, task/container `HEALTHY`, and completed rollout.
- These deployed revisions contain the original statistics implementation, not the uncommitted fallback fix. ECS health and successful deployment do not satisfy authenticated acceptance. ALB target health could not be queried because profile `vestearth` lacks `elasticloadbalancing:DescribeTargetHealth`; container health was verified directly.
- Real-account authenticated staging acceptance remains pending. The operator was asked to identify an approved test account or existing logged-in session without placing passwords/tokens in chat. Do not synthesize a token, create player rounds, or mark this gate passed from an unauthenticated 401.
- A fresh unauthenticated `GET https://api-test-gateway.gameslabs.app/api/v1/users/me/game-statistics` returned HTTP `401`, structured error code `UNAUTHORIZED`, and `Missing authorization header`.
- Remaining sequence: explicit commit/publication phase for the fallback, staging deploy verification for that commit, then authenticated endpoint acceptance with response/round reconciliation and identity-isolation coverage. Keep the task open.

### Authenticated staging follow-up with operator-provided account

- The operator identified the local credential file `gameslab-admin-user-staging.md`. Values were read only into process memory; no password or bearer/refresh token was printed or stored in task artifacts. The credential file was not edited. Guidance: secrets-management.
- Login through `/api/v1/admin/auth/login` succeeded with HTTP/status `200`. The normal `/api/v1/auth/login` attempt returned HTTP `403`; its cause was not investigated. This verifies the real **admin-account** path, not ordinary-player login/role behavior.
- `GET /api/v1/users/me/game-statistics` with the issued token returned HTTP/status `200` and five ordered canonical categories: SLOTS, CRASH, ARCADE, MINIGAME, CARD. No TABLE was returned.

| Category | Top game | maxCoinWin | totalWins | capturedRounds | roundsPlayed |
| --- | --- | --- | --- | --- | --- |
| SLOTS | Seraph | number `300000` | string `"16"` | string `"59"` | string `"59"` |
| MINIGAME | Animal Parade | omitted | string `"0"` | string `"0"` | string `"6"` |
| CRASH / ARCADE / CARD | `topGame: null` | unavailable | unavailable | unavailable | unavailable |

- Asserted the actual response JSON: int64 counters are strings, captured max is a number, the uncaptured game omits `maxCoinWin`, and unplayed categories emit `topGame: null`.
- A second authenticated request supplied an unrelated UUID in `userId` query and forged `userid`, `X-User-Id`, `Grpc-Metadata-userid`, and `Grpc-Metadata-X-User-Id` headers. It still returned HTTP `200` and identical caller statistics. Because the caller has nonempty history, this is evidence against these client selector paths overriding the caller; it is not two-account/ordinary-role coverage.
- Queried the same caller's read-only admin player-activity API with `sort=top_performance&limit=100&offset=0`: all 16 reported active-game entries were returned. Both selected games matched its rounds/wins/capture/max values and optional max presence. Seraph was the highest captured max among that API's Slots entries. This comparison shares the Game aggregate data source and is not independent controlled-fixture/raw-round proof; admin activity also excludes inactive games.
- Both selected games' public image URLs returned unauthenticated HTTP `200` with `Content-Type: image/png` via HEAD requests. No image files were downloaded.
- No game/round/account fixture data was created or edited. These checks exercised revision `75`, which still lacks the local fallback. Authenticated smoke is now verified; the full staging completion gate stays pending until the fallback is published/deployed and uncovered ordinary-player, controlled-fixture, and ranking/reversal cases are addressed.

### Display-name fallback deployed (2026-10-07)

- Commit `889039d` on `task/TASK-EAR-384-display-name-fallback` was merged to `staging` as `c037d3f` in https://github.com/SparqLab/Games-Labs-Game/pull/44.
- Deploy STAGING run `37627182446` succeeded. ECS `games-labs-game-staging:76` rollout is `COMPLETED`, desired/running `1/1`, image `staging-sha-c037d3f`. Revision 75 is no longer the primary deployment.
- The task stays open. Ordinary-player login and controlled-fixture acceptance were not run against revision 76.

### Independent verification after deployment

- Re-observed PR #44 as merged into `staging`, merge SHA `c037d3f83f22de83ebf21ae595b9e1609945fbd2`, matching current remote staging HEAD and successful Deploy STAGING run `37627182446`.
- Inspected commit `889039d`: its SQL and regression-test diff is identical to the change tested in the earlier real-Postgres red/green and Game suite/build/vet checks. Those source files have no diff between `889039d` and the merge commit. No code was changed in this verification pass; the same checks were not repeated.
- Fresh ECS reads verified Game primary revision `76`, image `staging-sha-c037d3f`, desired/running `1/1`, pending `0`, completed rollout, and running task/container `HEALTHY`. Gateway remains revision `126`, desired/running `1/1`, with completed rollout.
- Repeated admin-account login and statistics GET against the current deployment: HTTP/status `200`; five ordered canonical categories; the same Seraph and Animal Parade values recorded above; correct JSON counter types, omitted uncaptured max and null unplayed top games.
- Repeated the forged caller query/header request: HTTP `200` and the same nonempty caller response. Repeated the same-caller admin activity comparison: all 16 active-game items returned, both selected games' metrics and max presence matched. Both public images returned HTTP `200`, `image/png`, without authorization. Tokenless statistics GET returned `401`.
- Credentials/tokens stayed in process memory, and no game/round fixture data was modified. This proves authenticated admin-account smoke on revision `76`; the selected games have nonblank names, so live blank-name fallback fixtures, ordinary-player role coverage and independent controlled-round acceptance remain unverified. Keep the completion gate pending.

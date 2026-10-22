# TASK-EAR-385: Player Game Favorites and consistent isFavorite responses

## Context

- Operator request (2026-10-07): assess the App Home/Profile API request and open separate tasks when appropriate. This task covers My Games favorites; Profile statistics is TASK-EAR-384. Planning only is authorized in this session.
- App requests `isFavorite` in Frequently Played, Last Played and My Games, a personal favorites list and an explicit add/remove API. The screenshot shows heart controls and a Favourites tab.
- Current `shared-lib/proto/gamepb/game.proto` exposes those three GETs, all returning the shared `Game` message. It has playability fields but no favorite field/list/mutation. Searches of Game internals and migrations found no game-favorite persistence.
- Existing frequently/last handlers forward the path `user_id` to Game queries; My Games reads trusted `userid` metadata. Caller identity and path ownership must be defined together when introducing personal favorite state.
- Redemption favorites provide an existing set-state, caller-scoped and paginated contract pattern in `orderpb`/Order. Reuse its conventions as appropriate, but Game owns its own favorite relation; never read Order or User databases directly.

## Goal

Persist favorites per authenticated player and canonical Game UUID, expose a paginated favorites list, and return consistent favorite state across game responses used by Home/My Games.

## Scope and ownership

| Repository | Allowed changes |
| --- | --- |
| `shared-lib` | `proto/gamepb/game.proto`, generated protobuf/gRPC/gateway/OpenAPI, contract tests/examples |
| `Games-Labs-Game` | A new migration and its boot-runner registration, `internal/models/`, `internal/core/ports/`, Game repository/service/gRPC handler and focused tests; `go.mod` + `go.sum`; README/API docs |
| `api-gateway` | Published dependency bump, route/identity/serialization tests and API/Postman docs |

Public Game-message responses to audit/enrich: `ListGame`, `GetGameByID`, `ListUserGame`, `GetFrequentlyPlayedGamesByUserID`, `GetLastPlayedGamesByUserID` and the new Favorites list. This avoids adding a shared `Game.isFavorite` field that incorrectly reports false on a sibling authenticated response. Keep CategoryGame, admin/web contracts and unrelated catalog structures outside this scope unless a separate need is evidenced.

Out of scope: Android edits, Order favorite schema/behavior changes, User/Wallet changes, history/ranking rewrites, provider callbacks, bulk backfills, automatic task execution, commit/push/PR/deploy, production compute/RDS startup and unrelated task state.

## Proposed API contract

1. Add `bool is_favorite` with an unused field number to `gamepb.Game`; public proto JSON is `isFavorite`. A successful requested player response must emit both true and false explicitly. Shared-lib generation and gateway serialization must be tested together.
2. `GET /api/v1/game/favorites?limit=20&offset=0`: authenticated caller only, no client-controlled user selector. Use the standard status envelope, a `data` Game list and existing pagination conventions (`page.total`, limit, offset, size, totalPage; int64 JSON strings). Default limit 20, maximum 100, reject invalid paging values with an existing structured invalid-request error. Total is computed before slicing and remains correct beyond the final page.
3. `PATCH /api/v1/game/{game_id}/favorite`, body `{"isFavorite": true}` or `{"isFavorite": false}`. Set the desired state rather than toggling. Use presence-aware request boolean so `{}`, null and malformed/non-boolean input cannot silently clear a favorite. No body/query `userId` controls ownership; the path ID is the canonical `games.id` UUID, not provider game code.
4. Return standard status plus minimal authoritative result `{gameId, isFavorite}`. Duplicate true/false requests and clearing an already absent relation succeed without extra rows or state inversion. Concurrent writes use atomic database operations; final state follows committed set operations.
5. Existing Frequently Played / Last Played URLs remain intact. For player routes require their path `user_id` to equal the trusted authenticated caller before selecting history/enriching favorites; otherwise return structured forbidden. These self-only semantics must be documented in the App handoff. Do not rename/remove endpoints or infer caller identity from the path.
6. Enrich My Games and other shared Game-message responses from the same caller relation. Preserve existing Frequently/Last ranking, limit, active-game/provider filtering and My Games level-access behavior. Use a join or batched lookup, not a favorite query for each item. Failed favorite reads must surface an error rather than invent false values.
7. Favorites does not grant access or start a game. Proposed retention policy follows the existing favorites pattern: retain saved relations when games/providers become inactive/maintenance or level-locked, and show saved games as unavailable using explicit existing status/playability fields with documented reasons. Clearing must remain possible for a saved unavailable game. Do not route Favorites through My Games' playable-only filter.
8. Adding a favorite must target an existing visible catalog game; unknown/malformed IDs use existing structured errors and create no orphan row. Keep relations consistent for hard-deleted games through an explicit FK/cascade policy; do not add a tombstone system. Document the exact unavailable-game add policy before implementation.
9. Use deterministic Favorites ordering by initial favorite creation time DESC then game UUID. Repeated true preserves initial saved time. Auth failure, invalid input, path/caller mismatch, missing game and database failure must remain distinguishable using shared-lib errors; clients must not parse message text.

List retention/ordering and add-policy details are proposed backend defaults, not claims of prior App confirmation. Freeze examples in the contract step; record any requested change rather than silently widening the feature.

## Persistence and migration

- Store a Game-owned relation, proposed `game_favorites`, with unique `(user_id, game_id)`, canonical game UUID FK and timestamp. Follow existing user-ID storage conventions; do not introduce a cross-service User-table FK.
- Use atomic insert-on-conflict/no-op for true and caller-scoped delete for false; validate the game and mutation in a consistent transaction where needed.
- Add a forward migration and wire it into Game's existing embedded boot lane. Inspect current `migrations/run.go`, goose conventions and next migration number at implementation time. Verify a fresh database, repeat boot application and upgrade from the prior schema; do not edit an old applied DDL file.
- No new dependency or general favorites framework is expected. Reuse existing pgx, ports, image/name mapping, identity and shared error helpers.

## Acceptance Criteria

- [ ] Contract documents exact routes, identity ownership, request presence, JSON envelope/types, paging, ordering, errors, unavailable-game add policy, retention and clear/refresh behavior. Existing field numbers and list shapes are preserved.
- [ ] Migration creates one relation per user/game, rejects orphan game references and is exercised through both supported migration lanes without altering unrelated data.
- [ ] True/true and false/false requests are idempotent; an omitted/null/non-boolean `isFavorite` is invalid. A missing/malformed game creates no row. Atomic concurrent writes cannot create duplicate favorites.
- [ ] Two users favoriting the same game remain isolated. Missing auth, forged identity metadata and mismatched user path fail; selectors cannot read/mutate another player's favorite state.
- [ ] Favorites GET returns only the caller's saved games, correct total and stable pages, including a truthful empty list and offset beyond total. Duplicate true preserves ordering.
- [ ] Frequently Played, Last Played and My Games all return explicit true/false with the same authoritative state immediately after PATCH and after a new login/session. Existing ranking/filter/level access remains intact for legitimate self requests.
- [ ] Other authenticated shared `Game` responses do not expose an incorrect default false for a saved game; enrichment is batched and lookup failure is an error.
- [ ] Saved unavailable/level-locked games can still be unfavorited, with truthful status/playability; favoriting does not bypass launch checks. No game disappears merely because My Games filters it out.
- [ ] Proto checks/regeneration, focused auth/presence/idempotency/paging/migration tests, relevant full Go suites, readonly consumer builds and applicable lint/vet pass or have specific valid skip reasons. Use the same operator-published shared-lib version and no local `replace`.
- [ ] Authenticated staging gateway smoke sets true then false and verifies every requested list plus Favorites, new-session persistence, cross-user isolation, unavailable behavior and actual JSON boolean presence. Source/build/deploy registration alone is not acceptance.
- [ ] Final API/Postman examples and human Mobile handoff are available. Android checkout remains read-only.

## Technical plan and sequencing

1. `dev-2`: freeze the additive `Game.isFavorite`, paginated Favorites and presence-aware set-state contract using existing Order conventions; document the affected endpoints and defaults. Recheck current source and the shared-file schedule with TASK-EAR-384.
2. `dev-2`: change Game proto first, regenerate/check shared-lib, then stop for operator publish and supplied version. Workspace instructions explicitly require publication before downstream implementation; no copied local contracts or `replace ../shared-lib`.
3. `dev-2`: after publication, bump Game dependencies together, add migration/boot registration and repository/service/handler behavior. Test isolation, presence, concurrency, query batching, visibility and migration lifecycle.
4. `dev-2`: bump gateway to the same version, test new generated routes plus path-ID/body conflict and trusted identity/JSON presence, then update Postman/handoff docs.
5. Independent review and authenticated staging acceptance. shared-lib PR target `main`; Game/gateway targets `staging`, after inspecting workflows and verifying remote PR metadata. Production remains parked.

TASK-EAR-384 and TASK-EAR-385 have no feature dependency, but overlap in `gamepb` generated files, Game handler/ports and consumer module pins. Schedule those edits sequentially with one owner; do not create a fake `blocked_on` feature dependency. Favorites can proceed through contract preparation while Statistics waits on Product definitions.

## Source evidence (inspected 2026-10-07)

- Game `staging` HEAD `5525204`; shared-lib HEAD `4bcb80c`; api-gateway HEAD `54d25e9`. Working source inspection, not a deployed-runtime assertion.
- `shared-lib/proto/gamepb/game.proto:35`: Game RPC routes; shared `Game` response fields and the three requested list types. No game-favorite field/RPC found in the inspected proto.
- `Games-Labs-Game/internal/core/handlers/gamehdl/grpc.go:312`, `:372`, `:451`: metadata-based My Games and path-based played-list handlers; shared model mapper to extend.
- `Games-Labs-Game/internal/core/services/gamesvc/service.go:131`, `:219`, `:231`: current level, provider and played-list behavior.
- `Games-Labs-Game/internal/core/repositories/game.go:115`, `:166`: non-reversed-round Frequently/Last queries and active-game filtering.
- `Games-Labs-Game/migrations/` and `internal/`: no favorite storage/behavior found by exact and naming-variant searches.
- `shared-lib/proto/orderpb/order.proto:110` and `Games-Labs-Order/internal/core/handlers/orderhdl/grpc.go:628`: existing caller-scoped favorites/set-state/pagination conventions, read-only reuse reference.
- `api-gateway/gateway/grpc.go:78`, `gateway/http.go:105`, `middleware/identity_headers.go` and identity tests: actual protobuf JSON and trusted authentication path.
- Android `feature/game/data/remote/DevGameService.kt`: consumes the existing three paths; read-only reference, human Mobile integration only.
- SocratiCode green/manual local snapshot was used for navigation; actual proto, handlers, queries and migrations were checked before planning. No feature implementation, build/test run, runtime data query or deployment was performed.


## Operator closure review — 2026-10-22

Operator instructed: compare Dev App progress with Games-Lab-Android and close this task if fully wired. Closure acceptance for this pass is the source integration check; the remaining manual staging checklist is no longer a prerequisite for this operator-requested closure. This is not a claim that those live tests passed.

Reviewed Android `main` at `a6d7c1e40067ce987d103b52c6a458cd96160911` (clean worktree). Android was read-only; no Gradle build or device operation ran.

| Integration | Current source inspected | Result |
| --- | --- | --- |
| Real API and DI | `feature/game/data/remote/DevGameService.kt`, `GameFavoriteNetworkModule.kt`, `di/RepositoryModule.kt` | GET favorites with limit/offset and authenticated PATCH canonical gameId with desired Boolean are injected into the live backend. |
| Contract decoding | `feature/game/data/remote/DevGameApi.kt:303-425`, `dto/DevGameServiceDtos.kt` | Top-level data/page, string int64 paging, nullable flags, HTTP/service code and matching mutation acknowledgement handled. |
| Owner and persistence | `feature/game/data/repository/AppGameRepository.kt` | Captured session/environment, owner-change reset, shared flags, Room cache update and stale response protection; played paths use session user ID. |
| UI actions and sources | `feature/home/ui/GameHomeScreen.kt:135`, `HomeCategoryGamesScreen.kt:167`, `presentation/GameHomeViewModel.kt:471`, `GameHomePersonalGamesStateHolder.kt` | Hearts call the real mutation; Favorites uses server pagination, refresh/invalidation and removal; Home/My Games/played feeds share confirmed state. |
| Unavailable and locked rows | `presentation/GameHomeMyGamesSupport.kt`, `ui/components/GameHomeStripSection.kt:210-230`, `HomeCategoryGamesViewModel.kt:142` | Favorites projection supports unavailable rows; strip heart action remains separate from locked launch control. |
| Unknown writes | `AppGameRepository.kt`, `GameHomePersonalGamesStateHolder.kt` | Pending tap shield and bounded read reconciliation; no automatic uncertain PATCH replay. |

Existing regression sources inspected: `DevGameFavoriteApiTest.kt`, `AppGameRepositoryTest.kt`, `GameHomeFavoriteRecoveryViewModelTest.kt`. Test presence is source evidence only; no Android tests rerun in this review.

Prior Android manual evidence: `.codex/references/home-favourite-recovery-temp-plan-2026-10-15.md:182-203` records one authorized live add, server-backed Favorites membership, process-restart persistence and consistent VIP/Favorites/category state. This is a prior report, not fresh device verification. It expressly leaves live removal/round-trip, cross-device concurrency and process-durable uncertain-write recovery untested.

Conclusion: no missing wire found in the reviewed Favorites paths. Close TASK-EAR-385 under the operator's current source-integration acceptance. Mark the original authenticated_staging gate `na` with the explicit scope change, rather than misreporting a successful live QA run. Two ordinary-player live isolation, saved-then-disabled/provider lifecycle, full level-locked lifecycle and live removal remain unverified. No new deployment/runtime claim, Android write, commit, push or deployment was performed.

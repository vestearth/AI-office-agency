# TASK-EAR-147: Game classification epic — Phase 1: game_category table + admin API + assignment

## Type

feature

## Workstream

backend

## Priority

high

## Created

2026-07-18

## Epic

Canonical game-classification — Phase 1 of 5. Depends on TASK-EAR-146
(canonical set). Unblocks 148 (event emit) and 150 (backoffice).

## Goal

Make the canonical `game_category` taxonomy the admin-managed source of truth
in Games-Labs-Game, formalizing the **existing** `games.category` column
rather than adding a new one (TASK-EAR-146 staging audit found `category`
already deterministic per game, not messy free text — see 146 findings).

## Scope (Games-Labs-Game, + shared-lib proto for the admin API)

1. `game_categories` lookup table: `code` (PK, stable UPPER_SNAKE), display
   name, `active`, `sort_order`, timestamps. Seed exactly the 5 canonical
   rows from TASK-EAR-146: `SLOTS, CRASH, ARCADE, MINIGAME, CARD`.
2. **Pre-flight safety check (do this first):** run
   `SELECT DISTINCT category FROM games` on staging (re-verify) and on prod
   (146 only audited staging). If any value falls outside the 5 seeded codes,
   add a matching `game_categories` row for it before the next step — do not
   silently drop or rewrite an existing game's category. Flag anything
   unexpected back to the run instead of guessing.
3. Add a **foreign key on the existing `games.category` column** referencing
   `game_categories(code)` — no new column, no data migration/backfill (values
   already match per the 146 audit; step 2 exists only to catch the prod gap).
4. Admin CRUD RPC for `game_categories` (create/update/deactivate) +
   api-gateway route (add the proto `google.api.http` binding — Missions-style
   mux-only routes die at the gateway), plus a list endpoint (active rows)
   the Backoffice dropdown hydrates from.
5. `CreateGame` / `UpdateGame` already get FK-level rejection of an unknown
   category; add a friendly application-level error message instead of
   surfacing the raw constraint violation.

## Acceptance

- FK constraint applies cleanly on staging and prod (step 2 catches any gap
  first — no failed migration, no orphaned category values).
- Taxonomy table + admin CRUD live through the gateway (authenticated round
  trip 200/401, not 404).
- `CreateGame`/`UpdateGame` reject invalid/empty category with a clear error;
  accept any of the 5 valid codes.
- List endpoint returns the active taxonomy (5 rows) for Backoffice.
- `go build` + `go test ./...` green. PR targets staging.

## Admin-managed, no deploy to add a type

Adding a new game type = inserting a `game_categories` row via admin, not a
code change (decided 2026-07-18, source-of-truth = DB table).

## Execution plan (coordinator, 2026-07-18) — 3 sequenced repo stages

Recon confirmed: `admingamepb` (shared-lib `proto/admin/admingamepb/admingame.proto`)
already has a `Category`/`CategoryGame` CRUD block (`ListCategory`,
`CreateCategory`, `UpdateCategory`, `DeleteCategory`) to mirror — but that is
the **curated Mobile-display** category (out of scope, do not touch/reuse).
Build a **new, separate** `GameCategory` message + RPC set so the two never
collide. `AdminGameService` is already registered wholesale in api-gateway
(`gateway/grpc.go:91`), so a new RPC on the same service needs **no gateway
code change** — only a shared-lib dependency bump once merged. Games-Labs-Game
has no local `.proto`; it only consumes shared-lib generated types. shared-lib
PRs target `main` (not `staging`); Games-Labs-Game and api-gateway PRs target
`staging` per this epic's convention.

**Stage A — shared-lib (proto + codegen), dispatched first, standalone PR:**
- Edit `proto/admin/admingamepb/admingame.proto`. Add, grouped right after the
  existing Category/CategoryGame block, clearly commented as a distinct
  concept ("game-scoping taxonomy for missions, NOT the Category above"):
  - `message GameCategory { string code = 1; string display_name = 2; bool active = 3; int32 sort_order = 4; }`
  - `ListGameCategoryRequest {}` (or `google.protobuf.Empty`) /
    `ListGameCategoryResponse { basepb.StatusResponse status = 1; repeated GameCategory data = 2; }`
    — returns ALL rows (active + inactive) sorted by sort_order; callers filter.
  - `CreateGameCategoryRequest { string code = 1; string display_name = 2; bool active = 3; int32 sort_order = 4; }` /
    `CreateGameCategoryResponse { basepb.StatusResponse status = 1; GameCategory data = 2; }`
  - `UpdateGameCategoryRequest { string code = 1; string display_name = 2; optional bool active = 3; int32 sort_order = 4; }`
    (`code` is the immutable PK/path param — mirror the existing
    `optional bool is_active` presence-tracking trick from `UpdateCategoryRequest`) /
    `UpdateGameCategoryResponse { basepb.StatusResponse status = 1; GameCategory data = 2; }`
  - **No `DeleteGameCategory` RPC.** `games.category` will carry a FK to
    `game_categories(code)` (TASK-EAR-147 Stage B) — a hard delete could
    orphan games. Deactivation is `UpdateGameCategory{active:false}` only.
  - RPC block (`google.api.http`):
    - `rpc ListGameCategory(...) returns (...) { option (google.api.http) = {get: "/api/v1/admin/game-category"}; }`
    - `rpc CreateGameCategory(...) returns (...) { option (google.api.http) = {post: "/api/v1/admin/game-category" body: "*"}; }`
    - `rpc UpdateGameCategory(...) returns (...) { option (google.api.http) = {put: "/api/v1/admin/game-category/{code}" body: "*"}; }`
- Regenerate: `cd shared-lib && make buf` (runs `buf format` + `buf generate` +
  swagger gen across the whole repo — this is the repo's normal full-regen
  flow, not scoped to one proto file; expect other files' generated output to
  reformat too, that's normal, do not hand-edit generated diffs).
- `go build ./...` in shared-lib to confirm it compiles.
- Commit, push a feature branch, open a PR **to `main`**.
- **Stop here.** Do not proceed to Games-Labs-Game or api-gateway in this
  same run — this PR must merge first so consumers can pin the real merged
  commit (not a branch/local path). Report the PR URL and stop.

**Stage B — Games-Labs-Game (table + migration + handler), after Stage A merges:**
- `go get github.com/SparqLab/shared-lib@<merged-commit>` to bump the pin.
- New migration `030_game_categories.sql` (check `030` is still free at
  execution time): `CREATE TABLE game_categories (code TEXT PRIMARY KEY,
  display_name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0, created_at ..., updated_at ...)`; seed
  the 5 canonical rows (`SLOTS, CRASH, ARCADE, MINIGAME, CARD` — display
  names TBD by whoever executes, e.g. "Slots"/"Crash"/"Arcade"/"Mini Game"/"Card").
- **Pre-flight safety check** (per task Scope step 2): query
  `SELECT DISTINCT category FROM games` on staging AND prod before the next
  migration; any value outside the 5 seeded codes needs a seeded row added
  first — do not proceed with the FK if this turns up something unexpected,
  surface it back to this run instead.
- Follow-up migration adding the FK: `ALTER TABLE games ADD CONSTRAINT
  games_category_fkey FOREIGN KEY (category) REFERENCES game_categories(code)`.
- Admin gRPC handler in `internal/core/handlers/admingamehdl/grpc.go`
  implementing `ListGameCategory`/`CreateGameCategory`/`UpdateGameCategory`,
  mirroring the existing `ListCategory`/`CreateCategory`/`UpdateCategory`
  handlers structurally (same file, same service, different backing table/repo).
  Wrap FK violations from `CreateGame`/`UpdateGame` with a friendly error
  instead of the raw constraint message.
- `go build ./...` + `go test ./...`, commit, push, PR to `staging`.

**Stage C — api-gateway (dependency bump only), after Stage B merges (or in
parallel once Stage A merges — gateway only needs shared-lib's new commit,
not Game's):**
- `go get github.com/SparqLab/shared-lib@<merged-commit>`, `go mod tidy`,
  confirm it builds, PR to `staging`. No code changes expected — the new
  routes are wired generically by `RegisterAdminGameServiceHandlerFromEndpoint`.
- Verify with an authenticated round trip (200/401, not 404) once both Game
  and gateway staging deploys are green.

# TASK-EAR-187 — Win capture T1b: Game read/write path + gateway bump (Game tab Phase B)

## Type

feature

## Priority

high

## Context

T1a is done: shared-lib#34 merged to main 2026-07-31 (TASK-EAR-184) — the
contract (`gamepb.SettleRoundRequest.win_amount = 8`, `RoundSettlement = 7`,
`admingamepb.PlayerGameActivityItem` fields 6/7/8) is live and the
AGENTS.md:275 publish gate is satisfied. This run is **T1b of the
TASK-EAR-183 spec v1.3 split**: make Games-Labs-Game store/serve win data and
rebuild api-gateway against the new shared-lib.

**READ `runs/TASK-EAR-183/win-definition-spec.md` (v1.3) FIRST** — §3
(monotonic GREATEST + the xmax trap), §5 (NULL-vs-0), §6 (schema/query/FE
notes), §2.1 (locked Total Wins = rounds with any payout).

## Scope — two repos, two PRs

### Games-Labs-Game

1. **shared-lib bump** to the post-#34 pseudo-version off main. AGENTS.md:282
   rules: never a `replace`; `go mod tidy`; commit `go.mod` + `go.sum`
   together; verify `GOWORK=off go build -mod=readonly ./...`.
2. **Migration `032_round_lifecycle_win_amount.sql`** exactly per spec §6:
   `ADD COLUMN IF NOT EXISTS win_amount DOUBLE PRECISION` + column COMMENT
   (gross round payout, >= 0, NULL = not captured) +
   `CREATE INDEX IF NOT EXISTS idx_round_lifecycles_user_id ON
   round_lifecycles (user_id)`. Every statement idempotent — Game replays the
   full hardcoded sequence every boot with **no version table**
   (`migrations/run.go:53-111`), so the file must be added BOTH as a
   `//go:embed` var AND an explicit `Exec` in `Run()`. Prove idempotency by
   applying twice (second run a no-op).
3. **`UpsertRoundSettlement`** (`internal/core/repositories/game.go:1506-1561`):
   `ON CONFLICT (round_id) DO NOTHING` → the win-only monotonic update from
   spec §3 (NULL-preserving double-COALESCE `GREATEST`; `settled_amount` /
   `settled_at` / `game_type` stay immutable).
   ⚠️ **The xmax trap is the dangerous part**: `inserted` is currently
   detected via `pgx.ErrNoRows` from `DO NOTHING` (:1542-1549), and
   `gamesvc/service.go:337-341` DELETES the row when event publish fails and
   `inserted` is true. With `DO UPDATE`, `RETURNING` always yields a row —
   switch detection to `RETURNING (xmax = 0) AS inserted`. Required
   regression tests: (a) settle 20 then delayed settle 10 → stored stays 20;
   (b) NULL + NULL → stays NULL (never coerced to 0); (c) duplicate settle
   reports `inserted = false`; (d) publish-failure on a duplicate settle
   does NOT delete the pre-existing row.
4. **Write path presence**: `SettleRound` handler
   (`gamehdl/settle_round.go`) + model (`RoundLifecycle`) + service carry
   `win_amount` end-to-end respecting proto3 presence — **do NOT copy the
   `> 0` gate** used for settled_amount (:43-46): a present `0` win must be
   stored as 0 (spec §5). `RoundSettlement` response echoes the stored value.
5. **`ListPlayerGameActivity`** (`internal/core/repositories/game.go:222-275`):
   add `MAX(rl.win_amount) AS max_coin_win`,
   `COUNT(*) FILTER (WHERE rl.win_amount > 0) AS total_wins` (locked Option
   A), `COUNT(rl.win_amount) AS captured_rounds`; new server-validated sort
   key `top_performance` with **`ORDER BY max_coin_win DESC NULLS LAST`**
   (Postgres default puts NULLs first on DESC — never-captured games must
   not rank on top). Extend model (`internal/models/game.go:93-102`), port
   (`ports/repositories.go:84-90`), service
   (`admingamesvc/service.go:89-95`), and handler mapping
   (`admingamehdl/grpc.go:419-458`) for fields 6/7/8.
6. Full test pass: `go build ./... && go vet ./... && go test ./...`.

### api-gateway

7. **shared-lib bump only** (same AGENTS.md:282 rules). No route changes —
   `GET /api/v1/admin/game/{user_id}/player-activity` already exists; the
   rebuild is what makes the new response fields serializable. Separate PR in
   the gateway's staging lane (this exact class has bitten 4x —
   EAR-147/159/164/172).

## Deploy order + verification

Game merges/deploys FIRST (migration 032 boots and the column exists before
anything queries it), then gateway. Both staging lane — verify each repo's
current PR base convention with `gh pr list` before opening (staging-forward
pattern per EAR-180/181 precedent). **Post-deploy proof, not green builds**:
curl the staging endpoint and show `maxCoinWin` / `totalWins` /
`capturedRounds` keys present in the JSON (camelCase — grpc-gateway emits
camelCase for typed protos; values will be null/0 until providers ship, which
is correct §5/§6 behavior). Check ECS rolloutState=COMPLETED for both
services before curling.

## Acceptance criteria

- Both PRs open (Game, gateway) with builds/tests green; migration proven
  idempotent (applied twice).
- The four upsert regression tests above, plus write-path presence tests
  (win 0 stored as 0; absent stays NULL).
- Query returns the three new aggregates with `top_performance` sort ordering
  NULLs last (repository test).
- Staging curl evidence of the three camelCase keys after both deploys (or,
  if merges are held for review, the exact curl command + expected shape
  documented in the run for post-merge verification).
- No Provider, no FE, no accumulation changes.

## Out of scope

- Provider adapters (T2/T3 — incl. the `WIN_CAPTURE_PROVIDERS` kill-switch),
  backoffice FE (T4), §9 defect runs (TASK-EAR-186 runs separately), prod
  lane (staging-forward; prod rides the consolidated prod patch which must
  carry migration 032 before any prod Provider sends field 8).

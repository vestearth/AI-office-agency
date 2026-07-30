# TASK-EAR-164 — Game tab Phase A: wire Frequently played + Last played (read-side only)

## Context

Phase A of the approved TASK-EAR-160 design
(`runs/TASK-EAR-160/game-tab-design-proposal.md`). Operator approved the
two-phase split on 2026-07-27: ship Frequently played + Last played now as
a pure read-side change; Top Performance (Max Coin Win / Total Wins,
requires win-amount capture through the settlement write path) is Phase B,
deliberately not scoped yet.

Key fact from the proposal: the exact aggregation queries already exist as
**dead code** in Games-Labs-Game —
`internal/core/repositories/game.go:114-141`
(`GetFrequentlyPlayedGamesByUserID`) and `:163-190`
(`GetLastPlayedGamesByUserID`), GROUP BY over `round_lifecycles` computing
play_count / last_played_at per (user, game), `reversed_at IS NULL`
filtered. Zero callers anywhere (Game, gateway, backoffice all grepped).

## Objective

Expose those aggregates through an admin RPC and wire the Player Detail
page's Game tab **Frequently played** and **Last played** sub-tabs to real
data. **Top Performance stays mock** — do not touch it, and do not touch
the settlement write path, `SettleRound`, or any Provider adapter.

## Scope (same 4-repo shape as TASK-EAR-159)

1. **shared-lib** — new admin RPC on `admingamepb` (follow existing
   conventions there), e.g. `ListPlayerGameActivity(user_id, sort, limit)`
   returning rows shaped for both sub-tabs: `game_id, game_name, category,
   rounds_played, last_played_at`. Note: win-amount fields deliberately
   omitted — Phase B adds them when capture exists. GET binding under
   `/api/v1/admin/game/...` mirroring existing admingamepb paths.
2. **Games-Labs-Game** — admin handler calling the two existing repository
   functions (or one merged query if that's cleaner — they hit the same
   table with the same GROUP BY), enriching game_id → name/category from
   the games table the way the existing repo queries already join or the
   service layer already does elsewhere. No schema change, no new table
   (the proposal's `player_game_stats` aggregate table is Phase B
   territory — Phase A reads round_lifecycles directly via the existing
   queries).
3. **api-gateway** — shared-lib bump; verify auto-wiring via the existing
   generic admingame registration + admin prefix auth (mirror TASK-EAR-159's
   verification: route-order collision check, no redundant auth entry).
4. **Games-Labs-backoffice** — wire Frequently played + Last played
   sub-tabs, data-source-only per `preserve-ux-design-wire-data-only`
   (no template changes; win columns on Frequently played that have no
   backing data render as the existing honest fallback, same pattern as
   TASK-EAR-137's payment-method `-`). Top Performance untouched (mock).

## Acceptance criteria

- Both sub-tabs render real per-player rows from `round_lifecycles`
  aggregates; Top Performance still mock, unchanged.
- No changes to SettleRound, RoundLifecycle model/proto, or any Provider
  adapter — diff must be verifiably read-side only.
- Frequently played's Max Coin Win / Total Wins columns show an honest
  empty fallback (no fabricated numbers) until Phase B.
- Build/vet/test clean in all Go repos; backoffice build + typecheck at
  parity with baseline.
- Same commit/PR discipline as TASK-EAR-159: nothing committed/pushed/PR'd
  without operator confirmation; shared-lib merges first, dependents pin
  real commits (no local-path replace in anything pushed).

## Out of scope

- Top Performance / win-amount capture (Phase B — needs per-provider
  "win" definition spec first).
- The `player_game_stats` aggregate table from the proposal (Phase B
  optimization; Phase A query volume is admin-page-only and fine reading
  round_lifecycles directly).
- Everything else on the Detail page (other tasks cover it).

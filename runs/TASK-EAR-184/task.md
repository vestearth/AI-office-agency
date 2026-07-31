# TASK-EAR-184 — Win capture T1a: shared-lib contract publish (Game tab Phase B)

## Context

TASK-EAR-183's win-definition spec v1.2 is the operator-accepted baseline
(verdict 2026-07-31: VERIFIED WITH CAVEATS, T1a unblocked). This run is
**T1a of the implementation split**: the shared-lib proto contract only,
ending at the AGENTS.md:275 publish gate — *"stop and ask the user to publish
and bump shared-lib first before implementing downstream service changes."*

**READ `runs/TASK-EAR-183/win-definition-spec.md` (v1.2) FIRST** — §5 (zero
vs absent), §6 (contract changes), and the locked definitions in §2/§2.1 are
the source of truth for every field comment below.

## Scope — shared-lib ONLY

`/Users/earth/Documents/GitHub/shared-lib`, two proto files + regeneration:

1. **`proto/gamepb/game.proto`**
   - `SettleRoundRequest` (:228): add `optional double win_amount = 8;`
     (fields 1–7 occupied; `optional` for proto3 explicit presence — a
     legitimate zero-payout round must be distinguishable from "not
     captured", spec §5).
   - `RoundSettlement` (:238): add `optional double win_amount = 7;` (echo).
   - Field comments must state the locked definition: gross round payout
     (total return credited for the round), >= 0, coin major units; absent =
     not captured, 0 = confirmed zero payout.
2. **`proto/admin/admingamepb/admingame.proto`**
   - `PlayerGameActivityItem` (:430-440): **remove `reserved 6, 7;`** (it was
     explicitly holding these numbers for this phase) and declare:
     `optional double max_coin_win = 6;` (MAX of win_amount, non-reversed
     rounds), `int64 total_wins = 7;` (comment: rounds with any payout —
     `win_amount > 0`; locked Option A), `int64 captured_rounds = 8;`
     (comment: rounds with non-NULL win_amount; 0 means win capture has no
     data for this game yet — consumers must render "-", never "0").
3. **Regenerate**: `make buf` (clean → `buf format -w` → `buf generate` →
   swagger regen via `scripts/swagtxt.go`); commit generated `*.pb.go`,
   `*_grpc.pb.go`, `*.pb.gw.go`, `*.swagger.json` alongside the protos.
   Never hand-edit generated files.

## Hard stop — publish gate

After the PR is ready: **STOP. Ask the operator to publish/tag shared-lib.**
Do NOT touch Games-Labs-Game, api-gateway, Games-Labs-Provider, or
Games-Labs-backoffice in this run — downstream bumps are T1b and later, in
separate runs, after the operator publishes (AGENTS.md:275; go.mod bump rules
AGENTS.md:282 apply to those runs, not this one).

## Acceptance criteria

- Proto diff matches spec §6 exactly (field names, numbers, `optional`
  presence, comments carrying the locked definitions).
- `reserved 6, 7;` removed in the same change that claims those numbers —
  never left dangling alongside the new fields.
- `make buf` runs clean; generated artifacts committed together with the
  protos; no other proto is touched.
- Backward compatibility stated in the PR description: all additions are
  additive/optional; old callers (Provider without field 8, gateway without
  the new response fields) remain valid.
- The run ends with the publish request to the operator, not with downstream
  edits.

## Out of scope

- Everything downstream: Game migration 032 + monotonic GREATEST upsert +
  (xmax = 0) fix + NULLS LAST query (T1b), gateway bump (T1b), provider
  adapters (T2/T3), FE (T4).
- The §3.1 accumulation Lua contract (lives in adapter runs).
- The two separate defect runs (§9.1 Sigma turnover, §9.2 1UP
  refund-reverse) — not yet opened, operator's call.

# TASK-EAR-186 — 1UP refund never reverses the round in Game (production-integrity fix)

## Type

bugfix

## Priority

high — operator-directed (2026-07-31): urgent, priority ABOVE the Top
Performance / win-capture epic. Independent of it.

## Context

Surfaced by TASK-EAR-183's spec pass (§9.2, all evidence re-verified in
source). 1UP's `/bets/refund` credits the stake back to the wallet but
**never tells Games-Labs-Game the round was reversed** — the round's turnover
stays counted in `round_lifecycles` and keeps feeding Missions
turnover/EXP/daily-activity scoring for a bet that was refunded.

Evidence (Games-Labs-Provider):

- Refund flow: `internal/core/services/oneup/callback.go:101-142` — looks up
  cached stake (`OneUpBetAmountFn`, :112), reserves the refund flag (:120,
  dedup exists), credits the stake back (:132 →
  `internal/core/services/oneup/wallet.go:357-367`), returns balance. Zero
  `gameadt.TryReverseRound` call sites in the whole oneup package.
- This path is HOT: per the 1UP spec, BetRefund fires whenever BetResult
  returns 4xx and retries every 15 minutes (`docs/oneUpSpin.txt:943-947`).
- Working precedent to mirror: IDG cancel →
  `internal/core/services/idg/callback.go:142-150` (the only wired
  `TryReverseRound` in the repo). `ReverseRoundInput`
  (`internal/adapters/gameadt/settle_round.go:25-31`) needs RoundID, UserID,
  GameID, ProviderCode, OccurredAt — no amount.
- Game side is ready and idempotent: `ReverseRound` no-ops on a second call
  and on already-reversed rounds
  (`Games-Labs-Game/internal/core/services/gamesvc/service.go:421-455`), and
  returns ErrNotFound for never-settled rounds — reads exclude reversed rows
  via `reversed_at IS NULL`, so a successful reverse removes the round from
  turnover aggregates and Missions sees `round.reversed`/`turnover.reversed`
  events (published by Game, not by Provider).

## Objective

After a successful refund credit, call `gameadt.TryReverseRound` so the
refunded round stops counting toward turnover-driven features.

## Implementation notes (verify, don't assume)

1. **Round identity must match what settle used.** BetResult's settle call is
   `callback.go:91-97` — confirm which value became `RoundID` (BetID) and use
   the same in the reverse. A mismatched id reverses nothing, silently.
2. **Refund may arrive for a round that never settled** — the refund trigger
   is BetResult FAILING (4xx), so the settle at :91 may never have run.
   `TryReverseRound` is fire-and-forget and Game returns ErrNotFound; this
   must stay non-fatal (log-only), exactly like the IDG precedent. Do not
   make the refund response depend on the reverse outcome.
3. **Reverse needs UserID + GameID, the refund request may not carry them.**
   Check what `/bets/refund` provides vs what the settle-time Redis state
   stores (`oneup/wallet.go:190-197` stores only the bet amount today). If
   GameID/UserID aren't recoverable at refund time, extend the settle-time
   reservation to cache them (same 7d TTL) — a small, backward-compatible
   state change; handle the cache-miss path (old reservations without the new
   fields) as log-and-skip.
4. **Ordering**: reverse only after the refund credit succeeds and the refund
   reservation is won (dedup) — a duplicate refund must not double-reverse
   (Game is idempotent anyway, but don't rely on it for correctness of logs).
5. **Test integrity rule**: regression test seen RED before the fix — at
   minimum: (a) successful refund → TryReverseRound called with the
   settle-matching RoundID; (b) refund for never-settled bet → no crash,
   refund still succeeds; (c) duplicate refund → reverse attempted at most
   once from this path. Follow the existing oneup test seams
   (`oneup/turnover_test.go`, hook vars at `oneup/callback.go:14`).
6. Provider deploys via its own lane (VPS docker-compose per TASK-EAR-097
   memory for provider — verify current deploy method before claiming
   shipped).

## Scope

- `Games-Labs-Provider` (oneup package + at most the gameadt call) only.
- No shared-lib, no Game, no proto changes — `ReverseRound` already exists.

## Acceptance criteria

- Refunded rounds disappear from turnover aggregates (verify on staging: 
  settle a round, refund it, confirm `reversed_at` set in Game and the
  round absent from `GET /api/v1/game/frequently-played/{user_id}` counts or
  via DB read).
- All three regression tests above, seen RED first.
- Refund HTTP response behavior to 1UP is byte-identical to before (the
  reverse is fire-and-forget).
- PR to the Provider repo's working branch; run validated + handoff notes.

## Out of scope

- Win capture (TASK-EAR-183/184 track), VP rollback no-op, GGSoft cancel,
  Sigma issues (§9.1 gets its own run later), AFB adjustment idempotency.

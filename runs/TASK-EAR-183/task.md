# TASK-EAR-183 — Top Performance (Game tab Phase B): per-provider "win" definition spec pass

## Context

TASK-EAR-160's approved design proposal (2026-07-27) split the Game tab into
two phases. Phase A (Frequently played + Last played, pure read-side wiring)
shipped as TASK-EAR-164 and is live. Phase B — **Top Performance**, which
needs `Max Coin Win` + `Total Wins` — was deliberately not opened because it
touches the **real-money settlement write path**: proto contract + Game's
`SettleRound`/`UpsertRoundSettlement` + all 6 provider adapters (afb, oneup,
sigma, vp, idg, ggsoft), each with distinct callback formats.

The proposal's explicit precondition (game-tab-design-proposal.md, decision
checklist item 3): *"who defines 'win' precisely per provider (some providers
batch multiple win/loss legs per round) — this needs a per-provider spec pass
before implementation, not just 'add a field.'"*

**This task is that spec pass.** Operator requested opening it on 2026-07-31.
Investigation/spec only — no code, schema, or proto changes.

## Objective

Produce a per-provider win-definition spec complete enough that a follow-up
implementation task can build `player_game_stats` + widen the settlement
contract without reopening product questions mid-implementation.

## Questions the spec must answer — per provider (afb, oneup, sigma, vp, idg, ggsoft)

1. **Where the win amount exists today**: file:line in each adapter's
   callback/settlement flow, and in what form (single value per round,
   multiple legs, cumulative vs delta, win-only vs win+bet pair). The 160
   proposal notes each adapter already computes win amounts internally
   before collapsing to turnover (e.g. `afb/service.go:420-497`) — verify
   this holds for all 6, not just AFB.
2. **Precise definition of "win"**: gross win vs net win (win − bet)?
   Recommend ONE product-level definition for `Max Coin Win` / `Total Wins`
   and provide the per-provider mapping to it. Flag any provider whose
   natural settlement value can't express the chosen definition.
3. **Multi-leg rounds**: for providers that batch multiple win/loss legs per
   round, how legs aggregate into one per-round win amount, and how
   duplicate/out-of-order callbacks are handled today (tie into existing
   idempotency in the settlement path).
4. **Reversals/rollbacks**: `round.reversed` exists in the settlement flow.
   Spec how a reversal affects the aggregates — `rounds_played` and
   `win_count` can decrement, but `max_win_amount` cannot be naively
   decremented. State the rule (recompute from rounds, tombstone, or accept
   staleness with a documented caveat) and its cost.
5. **Units/currency**: confirm all 6 providers report win amounts in the
   same currency/denomination as the turnover values already stored; call
   out any conversion or precision (decimal) concern.
6. **Proposed contract shape** (design only): exact field additions to each
   adapter's `SettleRoundInput`, the shared proto
   (`SettleRoundRequest`/`RoundLifecycle`), and a DDL sketch for
   `player_game_stats (user_id, game_id, rounds_played, win_count,
   max_win_amount, last_played_at)`. Note Game replays all migrations on
   boot — every statement must be idempotent. State deploy order across
   shared-lib → Game → Provider and rollback posture.
7. **Backfill**: re-confirm 160's "start empty, fill going forward" — do not
   expand scope unless the adapter inspection surfaces a materially new
   backfill lead, in which case flag it as a separate decision, not scope.

## Scope

- Investigation only: `Games-Labs-Provider` (all 6 adapters),
  `Games-Labs-Game` (settlement path, repo layer, existing dead aggregation
  queries at `internal/core/repositories/game.go:114-190`),
  `shared-lib` proto for the settlement contract.
- Deliverable: `runs/TASK-EAR-183/win-definition-spec.md`.
- No FE work — Top Performance stays mock until the implementation task.

## Acceptance criteria

- The spec answers all 7 questions with file:line evidence per provider — a
  per-provider table for Q1–Q5 is expected, not prose hedging.
- One recommended "win" definition is stated (not options), with the
  per-provider mapping and the reversal rule resolved.
- The contract-shape section is concrete enough to open the implementation
  task directly from it: fields, DDL sketch, deploy order, sized complexity.
- Operator reviews and either approves opening the implementation task or
  redirects — this task ends at the spec, it does not auto-continue into
  implementation.

## Out of scope

- Any implementation: schema migrations, proto changes, adapter edits, new
  RPCs, FE wiring.
- Phase A surfaces (Frequently played / Last played — live via
  TASK-EAR-164).
- The central admin-audit-event architecture discussion (separate,
  unrelated track).

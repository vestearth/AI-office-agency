# TASK-EAR-160 — Game tab (Player Detail): scope data capture before any build

## Context

From the 2026-07-27 Player Detail page audit (knowledge-base memory
`detail-page-backend-epic`, confirming an earlier 2026-07-18 finding): the
Game tab (Top Performance / Frequently played / Last played) is **100%
mock**, and unlike Earned/Redeem/Send-coin (TASK-EAR-159) or Special
Pass/Limited Avatar (TASK-EAR-158), there is **no existing data to read
from at all**:

- `round_lifecycles` (`Games-Labs-Game`) stores turnover only — no
  win/loss amounts.
- No round-history read RPC exists anywhere, even user-scoped.
- `Games-Labs-Logs` is write-only HTTP-callback logging (Postgres +
  ClickHouse), not gameplay outcomes — not a substitute analytics source.
- No analytics warehouse exists anywhere in the stack.
- The Missions "leaderboard" table is an unpopulated reward-config table
  (no `user_id`/score columns) — not reusable.

This was previously **deferred indefinitely** as "a product decision, not
an RPC task." Opening this task now to properly scope it — **not** to
commit to full implementation yet.

## Objective

Produce a concrete data-capture design proposal for what the Game tab
needs, before any schema or RPC work starts. This task's deliverable is a
**design/options doc**, not shipped code.

## Open questions the proposal must answer

1. What does "Top Performance" / "Frequently played" / "Last played"
   actually need per row — game name, session count, win/loss amount,
   last-played timestamp, something else? (Check the mock data shape in
   `mock.ts:599` `getPlayerGameRows()` as the UX contract to satisfy.)
2. Where should this data be captured — extend `round_lifecycles` in
   `Games-Labs-Game` (closest to the source), or is a new table needed?
   Capturing win/loss amounts touches the round-settlement path, which is
   higher-risk than a pure read-side addition — call out blast radius.
3. Is per-round detail needed, or would a per-player-per-game aggregate
   (updated incrementally) satisfy the UX? Aggregates are cheaper to
   query but harder to backfill for existing players.
4. What's the backfill story for players with existing round history that
   predates any new capture — is "starts empty, fills going forward"
   acceptable, or does backfill from raw logs need scoping too?
5. Rough RPC/schema shape and which service should own the new read
   endpoint (`Games-Labs-Game` vs `Games-Labs-Provider`, since Provider is
   closest to round/settlement data per the prior audit).

## Scope

- Investigation/design only: `Games-Labs-Game`, `Games-Labs-Provider`,
  `Games-Labs-Logs` (confirm still not reusable), `shared-lib/proto/admin`.
- No `Games-Labs-backoffice` FE change in this task — Game tab stays mock
  until a follow-up implementation task is scoped from this proposal.

## Acceptance criteria

- A written proposal answers all 5 open questions above with concrete
  file/table evidence, not speculation.
- The proposal explicitly recommends one approach (not just options) with
  a stated tradeoff, sized rough complexity (low/medium/high), and flags
  whether it touches the round-settlement write path (risk).
- Operator reviews and either approves scoping a follow-up implementation
  task, or sends it back with different direction — this task ends at the
  proposal, it does not auto-continue into implementation.

## Out of scope

- Any schema migration or RPC implementation — that's a follow-up task
  once the proposal is approved.
- Purchase → Special Pass/Limited Avatar (TASK-EAR-158), Earned/Redeem/
  Send-coin (TASK-EAR-159), Contact/Device Info mock fields, the Order
  IDOR — all separate, unrelated to this task.

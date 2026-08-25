# TASK-EAR-289 — Publish Game monitoring events

## Type

feature

## Workstream

backend

## Narrowed to Game only — 2026-08-24

This task used to cover **Game and Missions**. It was split by TASK-EAR-284 decision D6:
Game already publishes `player.activity`, Missions only consumes it, so one task
carried both a small additive change and a design problem. **Missions moved to
TASK-EAR-301.**

## Shape of this work — EXTEND

Game already publishes `player.activity`
(`internal/core/services/gamesvc/player_activity.go`, 3 non-test files). This task adds
fields and event types to a working publisher.

## Goal

Publish post-commit gameplay events required for the monitoring projection.

## Scope

- `Games-Labs-Game` only.
- Settled rounds, and the gameplay dimensions the Player Log and Report pages need.

## Gaps the pages need that today's events do not carry

`turnover.settled` and `round.settled` already give the game, category and settled
amount. The **gameplay** Player Log page also needs `bet`, `wl`, `thbWl` and
`vipLevel`, none of which the event carries.

`vipLevel` is the one to think about rather than just add: it is the player's level **at
the time of the round**, so it must be captured at publish time — resolving it later
gives today's level for a year-old row, which is the same class of mistake D5 avoids for
the actor name. Confirm Game can read it on the settle path without a cross-service call
in the hot loop; if it cannot, say so rather than adding a lookup there.

The **game** Report page additionally needs `rtp`, `totalPlayer`, `totalRound`,
`winAmount` and `pointGenerated` — those are aggregates computed by the projection
(TASK-EAR-285), not fields on the event. Do not publish pre-aggregated figures.

## Contract notes that bind every publisher task

- **Extend `PlayerActivityEvent`; do not invent a new envelope** (TASK-EAR-284 D1).
  Add event types and fields **additively**, following the file's own `game_category`
  precedent: optional, omitted when unknown, fail-open, and harmless to existing
  consumers.
- **Do NOT add `actor_id` to `PlayerActivityEvent`** to make the two streams uniform.
  Player activity has no actor; the projection gets actor identity from
  `AdminActionEvent` instead. A field that is empty on every row from its main producer
  will be misread later.
- **Model corrections as explicit reverse events** — `*.reversed` pointing at the
  original via `reverse_of_event_id`. Never encode a reversal as a negative amount; the
  contract forbids it and every Report aggregate depends on it.
- **Never publish credentials, tokens, or session values.** `AdminActionEvent.ActorAccess`
  was removed in TASK-EAR-217/225 because it persisted a live bearer token into a
  long-retention store that staff could read back. Tag 5 is `reserved` by number and
  name. The same rule binds every field added here.
- **Publish only after the authoritative state transition commits**, and carry a unique
  `event_id` per attempt so the projection can dedupe a retry at ingest.

## Acceptance criteria

1. Gameplay metrics derive from settled authoritative rounds only.
2. `bet`, `wl`, `thbWl` and `vipLevel` are carried, with `vipLevel` captured at settle
   time — or their absence is explained with the reason.
3. Reversals continue to publish as explicit `round.reversed` / `turnover.reversed`
   events referencing the original, never as negative amounts.
4. Publisher failures and retries, and payload correctness, are tested.
5. No pre-aggregated report figures are published on the event.

## Dependencies

Blocked on TASK-EAR-284 shared-lib publication and version bump.

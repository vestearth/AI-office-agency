# TASK-EAR-301 — Publish Mission monitoring events

## Origin

Multica issue SPAR-22 — Monitoring: publish Game and Missions events safely.

## Type

feature

## Workstream

backend

## Why this is its own task

Split out of TASK-EAR-289 by TASK-EAR-284 decision D6. That task bundled Game — which
already publishes `player.activity` and needs a small additive change — with Missions,
which does not publish it at all and carries a design problem the other five publisher
tasks do not have.

## Shape of this work — ADD, and resolve a loop risk first

**Missions is currently a `player.activity` CONSUMER**, not a publisher: all five
non-test references are reads (`internal/services/activity_match.go`,
`weekly_match.go`, the daily activity consumer). It does already publish
`admin_action` (`internal/handlers/adminmission/grpc/audit.go`), so the RabbitMQ wiring
exists.

🔴 **Resolve before writing code:** if Missions publishes onto the same stream it
consumes, a mission-progress event **re-enters its own matcher**. Decide and document
one of:

- publish onto a separate routing key the matcher does not bind, or
- filter by `source_service` on the consume side, or
- a different separation the design justifies.

Whichever is chosen, prove it with a test that publishes a mission event and asserts the
matcher does **not** process it. This is the acceptance criterion that matters most
here; the rest is routine.

## Goal

Publish post-commit mission events required for the monitoring projection.

## Scope

- `Games-Labs-Missions` only.
- Mission progress, completion, reward claim, streak, and pass activity.

## What the page needs

The **mission** Player Log page is the most complex of the eight — it renders **three
distinct row types**, so the event contract has to distinguish them rather than flatten
them:

- **daily / weekly**: `subtasks[]`, `progressCurrent`/`progressTotal`, `timeRange`,
  `missionStatus`, `completion`, `bonusClaimed`
- **monthly**: `longestStreak`, `missedDays`, `streakRestore`,
  `checkinsCurrent`/`checkinsTotal`, `rewardClaimed`
- **event**: `progressTitle`, `progressCurrent`/`progressTotal`, `type`, `rewardClaimed`

All three also carry `note` and `refer` — `refer` being the admin-driven case, which
arrives from `AdminActionEvent` rather than from this task. Do not publish an actor.

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

1. **A published mission event does not re-enter the Missions matcher** — proven by a
   test, not by inspection.
2. Events distinguish progress, completion, and claim, and carry enough to render all
   three row shapes.
3. Events are emitted only after the authoritative state transition commits.
4. Publisher failures and retries, and payload correctness, are tested.
5. Admin-driven mission activity is left to `AdminActionEvent`; no actor is published
   here.

## Dependencies

Blocked on TASK-EAR-284 shared-lib publication and version bump.

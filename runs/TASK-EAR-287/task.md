# TASK-EAR-287 — Publish Auth and User monitoring events

## Origin

Multica issue SPAR-20 — Monitoring: publish Auth and User account/VIP events.

## Type

feature

## Workstream

backend

## Shape of this work — ADD

Both services already have RabbitMQ publisher infrastructure — Auth publishes
`user_registered` and `admin_action` (`internal/core/ports/event_publisher.go`,
`adminauthhdl/audit.go`), User publishes `admin_action`
(`infrastructures/admin_action_publisher.go`). **Neither publishes `player.activity`**
(zero non-test references to `PlayerActivityEvent` in either service).

So this is *adding a stream to an existing lane*, not standing up publishing from
scratch. Reuse the wiring that is already there rather than introducing a second
publisher path.

## Goal

Publish safe, post-commit account and VIP/status events from Auth and User into the
extended `player.activity` contract.

## Scope

- `Games-Labs-Auth` and `Games-Labs-User` only.
- Cover registration, login, logout, player status, and VIP changes.

## What depends on this

The **account** and **vip-level** Player Log pages (TASK-EAR-290) have no other source.
They render empty until this ships.

Note the overlap to resolve during design: an **admin-driven** VIP change already emits
`AdminActionEvent` `user.vip_level.set` with `before`/`after`, and the projection reads
that stream too. Establish which transitions this task must publish and which are
already covered, so a single VIP change does not produce two rows on the same page.

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

1. Events are emitted only after the authoritative state transition commits.
2. Payloads carry the required audit dimensions but no credentials or session values.
3. Retry behaviour and publish-failure policy are tested.
4. VIP transitions do not double-publish against the existing `AdminActionEvent` path.

## Dependencies

Blocked on TASK-EAR-284 shared-lib publication and version bump.

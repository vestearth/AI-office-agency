# TASK-EAR-071: Wire "Randomly by System" resolution for Event Spend Prop (backend)

## Short name

`event-spend-prop-random-resolution`

## Type

feature

## Workstream

backend

## Created

2026-07-04

## Goal

Make the Event mission **Spend Prop** condition honor the product contract for
`special_item_category = "Randomly by System"`:

> When an admin sets Spend Prop to **"Randomly by System"**, the backend must
> randomly resolve it — at runtime, per user — to ONE concrete special item from
> the configured list (**Special Item / Special Pass / Limited Avatar**; the
> "Randomly by System" sentinel itself is excluded). Daily, Weekly, and Event
> each roll **independently** — the same player may resolve a different item on
> each surface, and a resolved item must be **remembered per user** (stable for
> that user on that surface, not re-rolled on every read).

This is a **backend + contract** task. The Backoffice UI (TASK-EAR-070) already
persists the admin's choice and needs no change.

## Background / evidence (current state)

- **FE persists a plain string.** `Games-Labs-backoffice` sends spend_prop as
  `params.special_item_category = "<label>"` via
  `app/utils/eventMissionMap.ts` (`buildConditionParams`). The dropdown options
  are `['Randomly by System', 'Special Item', 'Special Pass', 'Limited Avatar']`
  (`app/data/mock.ts`). Forward-compatible; no structured pool on events.
- **Event condition types are config-only and do not drive progress yet.**
  `Games-Labs-Missions/internal/services/mission_service.go:2131`:
  "config-only condition types (CATEGORY_TURNOVER/ANY_GAME_TURNOVER/SPEND_PROP)
  do not drive progress yet" — only GAME_TURNOVER accumulates. `SPEND_PROP` is
  defined at `internal/models/event.go` (`EventConditionSpendProp = "SPEND_PROP"`).
- **Daily/Weekly already have an admin-config random-selection pool** but NOT the
  runtime pick:
  - Daily: `daily_activity_pool_entries` table (migration
    `036_daily_activity_pools.sql`), `DailyActivityPoolEntry{entry_type: game|
    category|special_item, entry_ref, weight}` (`internal/models/models.go:684`),
    repo `ReplaceDailyActivityPoolEntries` / `ListDailyActivityPoolEntries`
    (`internal/repositories/daily_plan_repo.go`).
  - Weekly: `WeeklyActivityPoolEntry` (`internal/models/weekly_config.go`).
  - **The per-user runtime selection ledger is DEFERRED everywhere**:
    `daily_plan_repo.go:301` "per-user selection ledger is deferred (no
    daily_activity_pool_selections)"; `mission_repo.go:2524` "consumer_events
    ledger) is deferred to slice 2b". So the "pick one and remember it per user"
    behavior is unbuilt on ALL surfaces today, not just events.

Net: two gaps stack for events — (1) events store a bare string, not a
structured pool, and (2) nobody resolves the random pick at runtime with a
per-user memory.

## Contract decision (LOCKED — decision-grilling 2026-07-04)

**Chosen: Option B-hybrid.** Structured-pool parity with a generic, forward-
compatible ledger; wire events now, leave daily/weekly a fast-follow.

- **Representation:** events carry a structured special-item pool mirroring the
  existing `PoolEntry{entry_type: special_item, entry_ref, weight}` shape.
  "Randomly by System" expands **server-side** to the default candidate pool of
  the three concrete items — so **no immediate Backoffice FE change** is needed
  (the FE keeps sending the sentinel string; the backend materializes the pool).
  A concrete selection is a single-entry pool.
- **Ledger:** a new per-user selection ledger with a **generic `surface`
  discriminator** (`daily|weekly|event`) so it is reusable. **Wire the resolver
  for `event` now**; daily/weekly resolution is a fast-follow on the same schema
  (retires the deferred-ledger debt once, without shipping daily/weekly runtime
  changes in this task). Ledger key = **(user_id, surface, event_id)**.
- **Roll timing — Lazy + immutable:** resolve on the user's **first
  join/engagement** with the event; the resolved item is **locked for the
  event's lifetime**. Admin edits to the pool **do NOT re-roll** users who have
  already resolved (a resolved reward never changes under a player mid-flight).
- **Randomness:** **uniform** (matches the daily pool default `weight = 1` when
  `weight <= 0`, `daily_plan_repo.go:220`). Weighted selection is an explicit
  future option, not in this task.
- **Candidate set:** the three non-sentinel special items — **Special Item /
  Special Pass / Limited Avatar** — excluding the "Randomly by System" sentinel.

Independence falls out naturally: the ledger is keyed per surface, so a user's
`event` roll is independent of any future `daily`/`weekly` roll.

Downgraded from the pre-decision draft: the "Option B touches proto/gateway"
risk is largely void — the event admin API is a **plain HTTP passthrough**
(`internal/handlers/adminmission/http/events.go`; no `MissionEvent` RPC found in
`api-gateway`), so carrying/materializing the pool is a Missions-side JSON +
model change, not a gRPC contract change.

## Scope

Target service (primary):

- `Games-Labs-Missions` — models, repositories, migrations, mission_service
  runtime path, and the mobile-facing read that surfaces the resolved item.

Possibly affected (only if Option B and the admin must author candidates):

- `Games-Labs-backoffice` spend_prop editor — author the eligible special-item
  set (small follow-up; default to all three when sentinel is chosen).
- `api-gateway` / proto — only if the event admin request must carry a pool[]
  (Option B). Coordinate via `grpc-contract-review` / `api-contract-review`.

Out of scope:

- CATEGORY_TURNOVER / ANY_GAME_TURNOVER progress wiring (separate debt; only
  touch if the shared resolver naturally covers them).
- Any change to the already-approved TASK-EAR-070 Backoffice UI beyond an
  optional Option-B candidate-set authoring control.

## Acceptance criteria

- A documented contract decision (A or B) recorded in the run output and, if
  durable, promoted to `knowledge-base` (ADR).
- Event Spend Prop with "Randomly by System" resolves at runtime to exactly one
  concrete special item drawn from {Special Item, Special Pass, Limited Avatar},
  excluding the sentinel.
- The resolution is **persisted per user per surface** and is **stable** on
  subsequent reads for that user (no re-roll), and is **independent** across
  daily/weekly/event (a user may hold different resolved items on each).
- Concrete (non-random) special-item selections continue to behave as a fixed
  single value.
- Migrations are additive and reversible; no destructive change to existing
  daily/weekly pool tables.
- Unit/integration tests cover: random pick excludes the sentinel, per-user
  stability (same user → same item on re-read), and cross-surface independence.
- Backend build + test suite pass (`go build ./...`, `go test ./...` in
  `Games-Labs-Missions`).

## Risks (post-decision)

- **Ledger-schema generality vs YAGNI.** The `surface` discriminator is built now
  but only `event` is wired. Mitigation: keep the daily/weekly columns nullable/
  unused and covered by a schema comment; do not add daily/weekly write paths in
  this task.
- **Sentinel materialization drift.** The backend expands "Randomly by System" to
  the three-item pool; if the concrete item list changes, the default set must
  track it. Mitigation: source the default candidate set from a single constant
  and test it against the FE option list.
- **Lazy-roll race.** Two concurrent first-engagement events for the same user
  could double-resolve. Mitigation: unique constraint on (user_id, surface,
  event_id) + upsert-on-conflict returning the existing row.

## Assignment

Primary agent: `dev` (backend). Contract decision is **locked** (see above), so
dev proceeds to subtask 1 = write the ADR from the locked decision, then the
ledger + resolver. A `tech-lead-review` on the migration/ledger schema before
merge is recommended but not a gate.

## Next Action

Decision locked. Write the ADR, then implement:

```bash
./ai-dev-office/run-agent.sh TASK-EAR-071 dev
```

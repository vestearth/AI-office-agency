# TASK-EAR-285 — Build Logs monitoring read projection

## Origin

Multica issue SPAR-23 — Monitoring: correct ClickHouse dedupe acceptance before projection work.

## Type

feature

## Workstream

backend

## Goal

Create the idempotent read projection in Games-Labs-Logs that persists monitoring events and supports reporting queries without cross-service database access.

## Store — decided, do not re-litigate

**ClickHouse**, for both Player Log rows and Report aggregates (TASK-EAR-284 decisions D2/D3).

`Games-Labs-Logs` is already dual-store: Postgres holds `logs` and `admin_actions`
(`migrations/001_logs.sql`, `003_admin_actions.sql`), ClickHouse already holds provider
traffic (`internal/core/repositories/clickhouse_logs_repo.go`,
`provider_inbound_events` / `provider_outbound_events`). The client exists; reuse it.

## Scope

- `Games-Labs-Logs` only.
- Add ClickHouse DDL, consumer, read model, materialized views, repository, and tests.
- Consume **two streams** into one row model — see below.
- Deduplicate immutable event IDs **at ingest**, and record projection freshness / partial-data semantics.

## Active approved slice — 2026-08-26

Earth approved only the prerequisite proof slice to start now, after shared-lib
#55 published the event contract:

- durable `event_id` admission/deduplication before a ClickHouse insert;
- tests for sequential redelivery and the retry path, each proving one visible
  row and one aggregate effect; and
- no full projection, read API, report, or other rollout work until this proof
  is reviewed successfully.

This slice supersedes the prior dependency on all of TASK-EAR-284. The remaining
read-contract/gateway phase stays outside this task execution step.

## Approved corrective scope — 2026-08-26

The first implementation in Games-Labs-Logs did not satisfy the proof: its
consumer was not started from `cmd/main.go`, it did not bind a queue to
`amq.topic` / `player.activity.v1`, and its fake projector could not prove a
PostgreSQL-to-ClickHouse delivery. Earth approved this minimal corrective scope:

- create a minimal ClickHouse ingest table keyed by immutable `event_id`, plus
  the smallest aggregate proof object needed to demonstrate one row and one
  aggregate effect for a redelivery;
- start and bind the PlayerActivity RabbitMQ consumer in the Logs service;
- provide crash-safe admission recovery. A retry after an ambiguous delivery
  must verify the event's durable ClickHouse presence before it may project
  again; a permanent `processing` row or a blind lease retry is not acceptable;
- add real integration coverage using PostgreSQL and ClickHouse for sequential
  redelivery, projector retry, and crash-recovery behaviour.

This authorizes an ingestion proof only. It does **not** authorize Player Log
or Report read APIs, general-purpose report materialized views, gateway routes,
or Backoffice wiring. Those remain in TASK-EAR-284, TASK-EAR-286, TASK-EAR-290,
and TASK-EAR-291 respectively.

## The consumer reads two streams, not one

`player.activity` (`PlayerActivityEvent`) has **no actor** — it carries `user_id`, the
player the activity belongs to, and nothing that says who caused it. Actor is an
`AdminActionEvent` concept. The Player Log pages already encode this: `refer` appears on
exactly the four pages where an action can be admin-driven (wallet, mission, vip-level,
account) and is absent from the four that are always player-initiated.

```
player.activity  (PlayerActivityEvent)  ──┐
                                          ├──►  monitoring_player_events
admin.action     (AdminActionEvent)     ──┘
```

The row model carries a `source_stream` discriminator plus a **nullable** actor block.
Do not expect an actor on player-initiated rows.

## Actor display name — resolved here, at projection write time

TASK-EAR-284 decision D5. The publisher cannot supply it: `TokenData` carries no
username or email, which is why every `AdminActionEvent` publisher only ever had the id
(TASK-EAR-282). This consumer resolves it via `GET /api/v1/admin/user/{actor_id}`.

1. **Read the envelope `status.code`, not the HTTP status.** A missing id returns
   **HTTP 200** with `{"status":{"code":1000,...},"user":null}`. Verified live in
   TASK-EAR-282.
2. **Fail open to the raw id** with `actor_name_resolved = 0`. Never write a placeholder
   like "Unknown Admin" — that is a fabrication, which D4 forbids.
3. **Cache by `actor_id`.** Staff are few and slow-changing; without a cache this is one
   HTTP call per admin-sourced event.

## Table design

Two access patterns. **Do not serve both from one table.**

| | Player Log (TASK-EAR-290) | Reports (TASK-EAR-291) |
|---|---|---|
| access | row-level, per player or filtered list, time-ranged | aggregates over dimensions |
| object | `monitoring_player_events` | materialized views over the same source |
| `ORDER BY` | `(user_id, occurred_at)` | per view: `(game_id, date)`, `(package_id, date)`, … |
| `PARTITION BY` | `toYYYYMM(occurred_at)` | inherited |
| TTL | **set an explicit retention window** — this table grows with every settled round | inherited |

Reports must be **materialized views maintained on insert**, not ad-hoc aggregates
scanned at query time; `rtp` and `lifetimeGgr` over full round history will not hold a
dashboard latency budget. Every query carries a time filter and names its columns —
no `SELECT *`, no unbounded scans.

## Reversals must net out

`PlayerActivityEvent` models corrections as **separate explicit events** —
`turnover.reversed`, `spend.reversed`, `round.reversed` — each pointing at the original
via `reverse_of_event_id`. The contract **forbids** encoding a reversal as a negative
amount.

Every aggregate that sums or counts must therefore subtract reversed originals rather
than sum forward rows: `turnover`, `winAmount`, `rtp`, `totalRound`, `lifetimeGgr*`,
`purchaseCount`. `uniquePlayers` needs the same care — a player whose only round was
reversed is not a unique player for that period. This is live behaviour, not
hypothetical: the 1UP refund-reverse path shipped in TASK-EAR-186.

## Coverage marker

TASK-EAR-284 decision D4: data starts at go-live and earlier periods must render
partial/empty, never fabricated. The projection must expose the **earliest
`occurred_at` it can answer for**, so `coverage_start` on the read contract has a real
source. Without it, "nothing happened" and "we were not recording yet" are
indistinguishable and the UI silently reads the second as the first.

## Acceptance criteria

1. **Re-delivery must not create a duplicate _visible_ row, enforced at ingest by
   rejecting an `event_id` already seen.** ⚠️ Deliberately *not* "cannot create duplicate
   read rows": on ClickHouse that is unsatisfiable by `ReplacingMergeTree`, which
   collapses duplicates at **merge** time — asynchronously, with no bound — so a `SELECT`
   can return both copies indefinitely. `FINAL` forces it at read cost and must not be
   leaned on for every dashboard query. Both envelopes already carry a unique
   `event_id`; the dedupe simply has to run **before** the insert.
2. Order keys and partitions match the two access patterns above; report aggregates are
   served by materialized views, not query-time scans.
3. Aggregate tests prove reversals net out, including a period whose only round was
   reversed.
4. Actor-name resolution is tested for the `status.code` failure path and writes the raw
   id with `actor_name_resolved = 0`.
5. Tests cover filtering, paging, aggregate correctness, delayed events, and re-delivery.
6. No source-service database is accessed directly.
7. An explicit TTL / retention window is set and documented.

## Dependencies

Blocked on TASK-EAR-284 shared-lib publication and version bump.

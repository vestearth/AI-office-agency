# TASK-EAR-181 — Games-Labs-Logs bring-up: decide the job, then turn it on

## Type

feature

## Workstream

backend

## Priority

medium

## Created

2026-07-31

## Epic

Games-Labs-Logs activation. Originally filed as "P2" of a player-admin
data-completion plan whose premise was wrong — see the Correction below.

## ⚠️ Correction — the original justification for this run was false

This file was first written (and left truncated mid-sentence) claiming that
`player.activity.v1` events are persisted nowhere and that **"that is why the
Player Detail Game tab has zero backing data anywhere."** That is **not true**,
and no work should be scoped on it:

- **`round_lifecycles` (Games-Labs-Game, migrations 007 + 021) already
  persists per-round gameplay**: `round_id, user_id, game_id, game_type,
  is_promotional, settled_at, reversed_at, settled_amount`.
- **TASK-EAR-164 Phase A already shipped** the Game tab's *Frequently played*
  and *Last played* sub-tabs off aggregates over that table.
- The only Game-tab gap left is **Top Performance (Max Coin Win / Total
  Wins)**, and **Logs cannot supply it**: win/loss is collapsed to a single
  turnover value inside the six provider adapters before it ever leaves
  Provider. Fixing that means widening the settlement write path — that is
  TASK-EAR-160 Phase B, gated on three operator decisions in
  `runs/TASK-EAR-160/game-tab-design-proposal.md`.
- TASK-EAR-160 also checked Logs directly: what it stores today is provider
  callback metadata with **no `game_id`, no `round_id`, and no amount
  columns** — so it is not a latent gameplay source either.

The stale claim came from a MEMORY.md index line that had drifted from its own
memory body. Root cause and the general lesson are recorded; do not
reintroduce this reasoning.

## What Games-Labs-Logs actually is today — SECOND CORRECTION, verified in source 2026-07-31

**The README is stale too.** It says "minimal HTTP health service" with
"DB/migration wiring ... commented out in startup". That is not the code.
`cmd/main.go` on `staging` is fully wired and builds clean:

- Postgres init + `migrations.Run` on boot (`main.go:31-38`)
- Optional ClickHouse **dual-write**, degrading to Postgres-only if init fails
  (`main.go:42-50`) — added 2026-03-20 in `e32df05`
- gRPC `LogsService` registered (`main.go:70-72`)
- **The provider HTTP-events RabbitMQ consumer is already running**
  (`main.go:55-67`), gated on `RABBITMQ_URL`
- Migrations exist: `001_logs.sql` (`logs`) and `002_provider_logs_events.sql`
  (`provider_inbound_events`, `provider_outbound_events`), all
  `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` — idempotent
- Repo writes all three tables (`repositories/logs.go:24, 93, 117`)
- `ecs/env.names` already carries `RABBITMQ_URL`,
  `RABBITMQ_QUEUE_PROVIDER_EVENTS`, `RABBITMQ_CONSUMER_TAG_PROVIDER_EVENTS`;
  ECS staging/prod workflows exist (`ef776b9`)

**And the producer is live**: Games-Labs-Provider wraps its whole inbound mux
with the publisher — `cmd/main.go:100` builds `HTTPEventLogger`, `:384` does
`mux.HandleFunc("/", httpLogger.WrapInbound(mainHandler))`; bodies are scrubbed
and truncated to 16KB (`provider_events/events.go`).

**So Phase 1 is essentially already built.** It was never "scaffolding
commented out" — that description predates `e32df05` (March 2026). Do not
rebuild it.

## What Phase 1 therefore actually is

1. ~~**Verify it is really working on staging**~~ — **DONE 2026-07-31, PASS
   with a caveat.** Operator ran the read-only check on the Logs staging DB:
   `provider_outbound_events` holds **23,280 rows**, `max(created_at) =
   2026-07-27 17:15:59.956 +0700`. So the whole chain — Provider publishes →
   RabbitMQ → Logs consumer → Postgres — is real and has been running in
   production-like conditions, not theoretical. Phase 1 is confirmed built
   and working; it does not need rebuilding.

   ⚠️ **Caveat to resolve, not to panic about: the newest row is 4 days old**
   (last event 07-27, checked 07-31). Two innocent explanations and one that
   is not: staging Provider may simply have had no traffic since then (staging
   volume is genuinely low — TASK-EAR-168 measured ~2 gameplay events/day), or
   the consumer/RabbitMQ connection may have dropped silently. The consumer
   logs and reconnect behaviour in `infrastructures/rabbitmq.go` should be
   checked against Provider's own traffic in the same window before this is
   called healthy. Note the inbound-table count was not captured in the same
   pass — get it alongside.
2. 🔴 **The consumer never reconnects — found while investigating the 4-day
   gap, and it is a real defect on its own.**
   `infrastructures/rabbitmq.go` runs as a single `go` call from `main.go:56`
   and **returns on every failure path with nothing to restart it**:
   `amqp.Dial`, `Channel`, `QueueDeclare` and `Consume` each log-and-`return`
   (`:36-72`), and inside the loop `case msg, ok := <-msgs: if !ok { return }`
   (`:79-81`) exits the goroutine whenever the delivery channel closes — which
   is exactly what a broker restart, a network blip, or an idle-connection
   reap does.
   **Failure mode: consumption stops permanently and silently until the task
   is redeployed.** The service stays "healthy" — gRPC keeps serving, the
   health check passes, no alarm fires, and events published in the meantime
   sit in the queue (or are lost if it fills). This is the leading candidate
   explanation for the 4-day gap, and it must be fixed before the pipeline can
   be called reliable, whatever the gap turns out to have been.
   Fix shape: wrap the whole connect/consume cycle in a supervised loop with
   backoff, honour `ctx.Done()` for shutdown, and log reconnects. Consider
   `NotifyClose` so a dropped connection is detected promptly rather than
   inferred from a closed delivery channel.

   Second, lower-severity defect in the same file: a DB insert error does
   `msg.Nack(false, true)` (`:117`), requeueing forever. A poison message — a
   payload that can never insert — becomes a hot infinite loop. Needs a retry
   bound or a dead-letter path.

3. 🔴 **Retention — the other genuine gap, and a growth risk.** Grepped
   the entire repo: **no TTL, no partitioning, no prune, nothing.** These
   tables store full request AND response bodies (up to 16KB each) for
   **every provider HTTP call**, which is the highest-traffic surface in the
   platform. Unbounded. This must be fixed whether or not anything else in
   this run happens.
4. **Fix the README** so the next reader is not misled the way this run was.

## Job decision — DECIDED 2026-07-31: jobs 1 and 2, phased

Operator chose **both** the provider callback audit and the admin action
audit (chat, 2026-07-31), run as two phases in this task:

- **Phase 1 — provider callback audit.** The consumer is already scaffolded,
  so this is mostly wiring plus a Postgres target, and it proves the service
  works end to end before anything depends on it.
- **Phase 2 — admin action audit.** Net-new: schema, an ingestion path, and
  instrumenting the admin write paths across services. Phase 1's schema,
  retention mechanism, and repository seam are designed to be reused here, so
  do not shape Phase 1 as if it were the only tenant.

Job 3 (cross-service player timeline) is **not** chosen — it duplicates data
that already has owners and, notably, does not fix Top Performance.

## The candidate jobs as evaluated (kept for the reasoning trail)

Logs should own data that has **no authoritative home elsewhere**. Anything
already owned by a service (wallet ledger, orders, round lifecycles) should be
read from that service, not copied here — two copies of a money-adjacent fact
means two answers that can disagree.

1. **Provider callback audit** *(scaffolded, lowest risk, proves the service
   end to end)* — the consumer and ClickHouse repo are already written. Value:
   vendor-integration debugging and dispute evidence. Today those raw
   request/response bodies exist only in ephemeral logs.
2. **Admin action audit** *(net-new, arguably the highest value)* — who granted
   which e-voucher to which player, who reset a status, who changed a VIP
   level. **Nothing anywhere records this.** Directly useful to the admin
   surfaces this workspace has been building all month, and there is no other
   service that could claim ownership.
3. **Cross-service player timeline** *(optional, weakest case)* — persisting
   `player.activity.v1` would give one queryable stream across Game/Order/
   Wallet producers. It duplicates data that already has homes, so it is only
   worth it if a unified admin timeline is genuinely wanted. Do not scope it
   as a Game-tab fix; it is not one.

## Storage decision — DECIDED 2026-07-31: Postgres first

Operator chose **Postgres to start** (chat, 2026-07-31), matching this run's
recommendation. ClickHouse is not ruled out forever — it stays the right shape
if event volume later justifies it — but nothing new gets provisioned or
operated now.

Consequences to honour:

- Partition by time from the start, so a later archive/drop is cheap and a
  migration to ClickHouse is a copy rather than a rescue.
- Keep the write path storage-agnostic (a repository interface), so swapping
  the backing store later does not mean rewriting the consumer. The scaffold
  already has both `infrastructures/postgresql.go` and
  `infrastructures/clickhouse.go`, so the seam exists — do not hard-wire
  ClickHouse-specific SQL into the consumer.
- Retention/TTL is configured on day one. On Postgres that means an actual
  prune mechanism (partition drop), not just a documented intent — nothing in
  this workspace prunes anything today.
- `clickhouse_logs_repo.go` stays in the tree unused rather than being
  deleted; note in code that Postgres is the live path so the next reader does
  not assume ClickHouse is running.

## Non-negotiable constraints when this does start

- **Logs must never sit in a synchronous money path.** Consume asynchronously
  only; if Logs is down or slow, nothing else may degrade.
- **Every migration must be idempotent.** Logs uses the same boot-time
  replay-every-file runner as Missions and Game (`migrations/run.go`) — this
  workspace has already taken a production incident from a non-idempotent
  `ADD CONSTRAINT`.
- **Set retention/TTL on day one**, not later.
- If `player.activity.v1` is consumed, bind a **separate queue** from
  Missions' so scoring is unaffected, dedupe on `event_id`, and persist
  reversal events too — a store that keeps only forward events reports
  inflated totals.

## Scope

- **Phase 1**: verify the existing provider-event pipeline on staging, add
  retention (the real gap), correct the README. **Do not rebuild the
  consumer** — it exists and works.
- **Phase 2**: admin action audit — schema, ingestion path, and instrumenting
  admin write paths. Reuse Phase 1's retention mechanism and repository seam.
- Excluded: any read/admin API over the collected data (separate task once
  data exists and is proven), Top Performance / win capture (TASK-EAR-160
  Phase B), and copying data another service already owns.

## Acceptance Criteria

**Phase 1**

- Staging verified by **querying the tables**, not by the service reaching
  steady state: row counts and `max(created_at)` on
  `provider_inbound_events` / `provider_outbound_events` showing recent rows.
  If empty, the consumer wiring is the finding and the task pivots to that.
- Retention implemented and demonstrated: a prune/partition-drop mechanism
  that actually runs, with the window written down. A documented intention is
  not retention — nothing in this workspace prunes anything today.
- Any new migration is idempotent and proven so (applied twice, second run a
  no-op) — Logs replays every file on boot like Missions and Game.
- README corrected to describe the service as it is.

**Phase 2**

- Admin actions (at minimum: e-voucher grant, player status reset, VIP level
  set) land in the store with actor, target user, action, before/after where
  meaningful, and timestamp.
- Ingestion is asynchronous — an admin write must not fail or slow down
  because Logs is unavailable.
- Same retention mechanism applies, with its own window if different.

**Both**

- A stated-limitation section: what Logs does NOT capture, so the next reader
  does not assume it is a complete system-wide record.

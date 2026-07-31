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

## What Games-Labs-Logs actually is today

`GET /health` only — but the repo holds real scaffolding that is merely
commented out of startup: ClickHouse + Postgres + RabbitMQ infrastructures
(`infrastructures/`), a provider HTTP-event consumer
(`internal/models/provider_event.go`, `internal/core/repositories/clickhouse_logs_repo.go`),
and a migrations runner. The staging ECS service `games-labs-logs-staging`
already exists (port 8090/50060 per the ECS guides).

## The real candidate jobs — operator picks, this is the first deliverable

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

## Storage decision — OPEN, blocks implementation

ClickHouse hosting is an operator cost/ops call:

- **Option A — ClickHouse from day one.** The scaffold already targets it and
  it is the right shape for high-volume append-only events. Needs a decision
  on where it runs (ECS task, a VPS, or a managed service) and who operates
  it.
- **Option B — start on Postgres**, partitioned by time, and move later. Lower
  cost and no new infra to operate; fine for provider-callback and
  admin-action volumes, which are far below gameplay-event volume.

Recommendation: **Option B** unless job 3 is chosen, because jobs 1 and 2 do
not generate ClickHouse-scale traffic and Postgres is already wired in the
scaffold.

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

- Included: the job decision above, the storage decision, then wiring the
  chosen consumer into startup with migrations, retention, and health/observability.
- Excluded: any read/admin API over the collected data (separate task once
  data exists), Top Performance / win capture (TASK-EAR-160 Phase B), and
  copying data that another service already owns.

## Acceptance Criteria

- The chosen job and storage target are recorded in this run with the
  operator's rationale, before implementation starts.
- The chosen consumer runs in staging, persists real events, and is verified
  by querying the store — not merely by the service reaching steady state.
- Retention is configured and stated.
- Migrations proven idempotent (applied twice, second run a no-op).
- A stated limitation section: what this does NOT capture, so the next reader
  does not assume Logs is a complete system-wide record.

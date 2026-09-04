# TASK-EAR-309 — Consolidate the production RabbitMQ broker and separate it from staging

## Type

devops

## Workstream

devops

## Priority

**Do this before production is scaled up.** Not because it is the most severe item, but
because it is the *cheapest* right now and gets much more expensive later — see
[Why now](#why-doing-this-before-scale-up-is-the-whole-point).

## The defect, measured

Read from the **rendered ECS task definitions** (GitHub secrets are write-only; deployed
values are not). Values were hashed and credentials redacted; raw strings were never
printed.

| task definition | broker | port | fingerprint |
|---|---|---|---|
| **`games-labs-missions-prod`** | **Amazon MQ** `b-e177fb2b-f00b-4021-8366-5cbb82d2a3ad.mq.ap-southeast-1.on.aws` | **5671** TLS | `3a9c5231f85c` |
| wallet · order · game · auth · user · logs `-prod` | `84.247.150.206` | 5672 plaintext | `07b7ced3df69` |
| `*-staging` (4 sampled) | `84.247.150.206` | 5672 plaintext | `07b7ced3df69` |

Everything except Missions-prod shares one **byte-identical** connection string — same
host, same `admin` user, same password, same vhost `/`.

### Three problems, one table

1. **Missions-prod cannot hear its own publishers.** Game, Order and Wallet publish
   `player.activity` to the Contabo broker; Missions-prod listens on Amazon MQ. It would
   receive **nothing**, and nothing would error — no failed connection, no missing config,
   just silence. Daily/weekly progress, check-ins and turnover missions all sit at zero.
   This has the shape of a partial migration that reached exactly one service.
2. **Production and staging would share a broker, credentials and queue names.** Queue
   names default identically on both sides, and RabbitMQ round-robins consumers on a
   queue — so once prod scales up, **production events get delivered to staging consumers
   at random, and vice versa.** On money-adjacent streams that is not a QA nuisance.
3. **The legacy Contabo box is load-bearing for production.** `84.247.150.206` also hosts
   the ClickHouse that `prod.yml` falls back to (TASK-EAR-308). Both on a public IP, both
   on plaintext ports. This is what answered **D3** in `docs/PROD-ISSUES-2026-08-15.md`.

## Why doing this before scale-up is the whole point

**Every production service is at `desiredCount: 0` today.** So on the production side
there are no running consumers, no in-flight messages, and nothing to drain. Repointing
prod at a different broker right now is a **configuration edit and a redeploy** — there is
no cutover.

After launch the same change needs a drain window, a dual-consume period, and a plan for
messages already sitting in the old broker's queues. The work does not get harder because
the system gets bigger; it gets harder because it becomes **live**.

## ✅ Direction decided by devops — updated 2026-09-02

**Keep RabbitMQ on Contabo. One broker, shared by production and staging for now.**
Amazon MQ is off the table, which is consistent with this run's verification: the
endpoint in Missions' production config names a broker that does not resolve and has no
ENI in either VPC.

### The ask: one broker, **two vhosts**

**"One broker" and "one namespace" are different things.** A single RabbitMQ server hosts
many vhosts, and **a vhost is not a second broker** — it is `rabbitmqctl add_vhost /prod`
plus a user and a permission grant. No new server, no additional cost, no capacity change.
Devops' constraint is satisfied in full by a vhost.

This matters because a vhost is the **only** isolation that works here without code
changes, and the topology is what forces that conclusion.

### Why nothing cheaper works — measured, not assumed

`player.activity` does not go queue-to-queue. Publishers publish to an **exchange**, and
Missions binds a queue to it:

| | value | configurable per environment? |
|---|---|---|
| exchange | **`amq.topic`** — `Games-Labs-Missions/infrastructures/rabbitmq.go:18` | ❌ **hardcoded Go constant** |
| routing key | `player.activity.v1` — `shared-lib/events/player_activity.go:7` | ❌ shared-lib constant |
| queue name | `player.activity.missions` | ✅ via `RABBITMQ_QUEUE_PLAYER_ACTIVITY_MISSIONS` |

On a **shared vhost** there are exactly two outcomes, and both are broken:

- **Same queue name** → prod and staging consumers compete on one queue. RabbitMQ
  round-robins, so **production events are delivered to staging at random.**
- **Different queue names** → each queue bound to `amq.topic` with the same routing key
  gets **its own copy**. So **staging processes every production event, and production
  processes every QA event.** Production players' mission progress would move in response
  to QA activity.

**The second is worse, and it is what "just rename the queues" produces** — the change
that looks cheapest is the one that makes the failure bigger. And because the exchange is
a compiled-in constant, separating by exchange is not a configuration change at all: it
would touch every publisher, every consumer, and shared-lib.

A vhost scopes **exchanges as well as queues** — each vhost gets its own set of default
exchanges including `amq.topic` — so with `/prod`, **queue names can stay exactly as they
are** and the only edit is the connection string in seven services.

### The request to send devops

> Please create vhost `/prod` on the existing RabbitMQ, with a user and permissions for
> it. No new server is needed — this is a namespace on the broker we already run.

### If a separate vhost is refused

All remaining options are worse, and devops should see them before deciding:

1. **Rename queues per environment** — actively worse than today, per the table above.
2. **Make the exchange configurable** — touches every service plus shared-lib. No longer a
   config change, and a poor risk to take 18 days before launch.
3. **Accept the mixing** — defensible only as a recorded decision with the consequence
   stated: QA activity and production activity drive each other's missions, wallet and
   turnover events. It must not be arrived at by omission.

### Consequence for Missions

Missions-prod's Amazon MQ endpoint is replaced along with everything else. It stops being
a special case and joins the same prod vhost as its publishers, which is what fixes the
split brain.

### One risk this decision does not address — raising once, not relitigating

Contabo means production keeps talking to `84.247.150.206:5672` — a **public IP on
RabbitMQ's plaintext port**. Today that carries staging traffic; after launch it carries
production credentials and message bodies across the internet unencrypted, including
`player.activity` (wallet and turnover events).

Two ways to close it without changing the broker choice: enable **TLS on 5671** on the
Contabo RabbitMQ, or put the traffic on a private path (VPN or VPC peering) so 5672 is
not internet-exposed. Worth a decision, but it does not block this task.

## Scope

- `Games-Labs-Wallet`, `-Order`, `-Game`, `-Auth`, `-User`, `-Logs`, `-Missions` —
  `prod.yml` / environment configuration only. **No application code**, and with
  option **A** no queue-name changes either.
- Create the production vhost (or instance) on the Contabo RabbitMQ and its credentials.
- `RABBITMQ_URL` currently resolves from a **repo-level** secret with no production
  override in six of the seven; Missions has a production-scoped override. Whatever is
  chosen, set it the same way for every service so the next reader is not guessing.

## Out of scope

- Staging's broker. Leave it where it is.
- ClickHouse — that is TASK-EAR-308, even though it is the same host.
- Queue/exchange topology, DLQ policy, and the Missions `player.activity` consumer's
  `requeue=true` loop with no DLQ or backoff. Related and real, but a separate concern;
  raise it as its own task rather than widening this one.

## Acceptance criteria

1. Every production task definition renders the **same** `RABBITMQ_URL` fingerprint, and
   it is **different** from staging's — **including `games-labs-missions-prod`**, which
   today is the only outlier.
   ⚠️ If the chosen shape is a separate **vhost**, note that the fingerprint differing is
   necessary but not sufficient: confirm the **vhost path** actually differs, not just the
   password.
2. Production and staging cannot consume each other's messages — verified by an actual
   publish on one side and confirmation that the other side does not receive it, not by
   reading config.
3. `RABBITMQ_URL` no longer sits in plain task-definition environment. It carries
   credentials and is readable by anyone with `ecs:DescribeTaskDefinition` — the exact
   exposure that `POSTGRES_USER`/`PASSWORD` were deliberately moved into Secrets Manager
   to avoid. Move it the same way.
4. If prod moves to Amazon MQ, TLS (`5671`) is used and certificate verification is not
   disabled to make it connect.
5. The fingerprint comparison is written down as a reusable check — it is one command per
   service and it would have caught this months ago.

## Dependencies

None. Independent of TASK-EAR-308, though both point at the same legacy host and answering
one informs the other.

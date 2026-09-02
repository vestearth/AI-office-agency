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

## The recommended shape — one change fixes problems 1 and 2

**Move every production service onto Amazon MQ** (where Missions-prod already points) and
**leave staging on Contabo**. Consolidation and environment separation become the same
edit:

- problem 1 disappears because all prod services land on one broker
- problem 2 disappears because staging is then on a different broker entirely
- staging is the **running** environment, so not touching it avoids disturbing live QA
  and any in-flight staging messages

The alternative — moving prod onto Contabo alongside staging — would fix problem 1 but
leave problem 2, and would deepen the dependency on the legacy box that TASK-EAR-308 is
trying to get away from.

### 🔴 Verified 2026-09-02 — the Amazon MQ broker appears not to exist

Three independent checks, none needing `mq:*`:

| check | result | rules out |
|---|---|---|
| DNS for `b-e177fb2b-….mq.ap-southeast-1.on.aws` | **does not resolve** (`dig` empty, `getaddrinfo` NXDOMAIN) | a **public** broker — those have public DNS |
| Amazon MQ ENIs in either VPC | **none** — only APIGateway, RDS, ELB and ECS attachments | a **private** broker in `vpc-0f5f8b4202e646cae` or `vpc-01b1d37d17ff4c903` |
| the 3 blank-description ENIs | all in the **staging** VPC, plain `interface`, no `RequesterId` | these being the broker |

**So Missions-prod is not on a different broker — it is on no broker.** It would fail to
reach RabbitMQ at all on first boot, not merely miss events.

**The recommendation is unchanged**; only the target moves. Consolidating production onto
one broker and leaving staging on Contabo is still right, but the endpoint currently in
Missions' production config cannot be that broker. Either create one, or consolidate onto
a broker that exists.

**Ask before building:** how did a hostname for a non-existent broker reach a production
task definition? Either a broker was created and later deleted, or it was written in
anticipation and never provisioned — the `desiredCount: 0` state makes the second
entirely possible, and it would mean this config has never worked. Establish which.

*Limit:* three negative results are weaker than one positive one. `mq:ListBrokers` and
`cloudwatch:ListMetrics` were both `AccessDenied`. This would be falsified by a broker in
a third VPC or one reachable only via a private hosted zone. **Granting
`mq:DescribeBroker` to the `vestearth` user settles it in one command** and is the
cheapest next step.

## Scope

- `Games-Labs-Wallet`, `-Order`, `-Game`, `-Auth`, `-User`, `-Logs`, `-Missions` —
  `prod.yml` / environment configuration only. **No application code.**
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
   it is **different** from staging's.
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

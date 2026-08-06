# TASK-EAR-221 — 🔴 Order's admin audit publisher is silently disabled on staging (and prod)

## Type

fix / infra

## Priority

high

## Discovered

2026-08-06, by TASK-EAR-219's live staging verification. Two real e-voucher
grants were performed successfully (HTTP 200, real `UserRedemptionItem` rows
returned) and **neither produced an audit row**. Reading
`GET /api/v1/admin/audit-events?actions=order.redemption_item.grant` returned
`total: "0"` — zero rows of that action have ever existed.

Not a deploy timing artifact: the `25e4210` staging deploy finished ~07:54 UTC,
the first grant was 07:57:57.

## Root cause — verified in source, all three legs

Order never receives `RABBITMQ_URL`, so the publisher is nil and every admin
audit event is dropped with a `[AdminAudit] publisher disabled` log line.

| Leg | Games-Labs-Missions (works) | Games-Labs-Order (broken) |
|---|---|---|
| `ecs/env.names` | lists `RABBITMQ_URL`, `RABBITMQ_QUEUE_ADMIN_ACTIONS` | **no rabbit entries at all** |
| `.github/workflows/staging.yml` | `RABBITMQ_URL: ${{ secrets.RABBITMQ_URL }}`, required-check, `export RABBITMQ_URL` | **no rabbit references at all** |
| config default | — | `URL string \`envconfig:"RABBITMQ_URL"\`` — **no default**, so `RabbitMQURL()` returns `""` |

ECS env is built solely from `ecs/env.names` via `ecs/build-env-json.sh`, so a
name absent there can never reach the container regardless of secrets.

## Blast radius — wider than TASK-EAR-219

This is **pre-existing** and not caused by TASK-EAR-219 or #30. It means:

- The entire Order half of **TASK-EAR-188** (the `order.redemption_item.grant`
  audit trail) has never produced a single row on staging.
- TASK-EAR-219's Order enrichment (`voucher_name`, `valid_until`) is unverifiable
  until this is fixed — including, importantly, the **live** proof that no
  redeemable code leaks into the audit row. That check is currently
  **inconclusive**, not passing.
- Prod is configured the same way, so the same gap exists there.
- Any other Order RabbitMQ publisher (e.g. the pre-existing player-activity one)
  is equally disabled.

## The fix — two files, and only one of them is pushable from the Claude lane

1. **`ecs/env.names`** — add `RABBITMQ_URL` and `RABBITMQ_QUEUE_ADMIN_ACTIONS`.
   Pushable normally.
2. **`.github/workflows/staging.yml`** — mirror the Missions pattern: pull
   `RABBITMQ_URL` from `secrets.RABBITMQ_URL` in the render step's `env:` block
   and `export` it alongside the other values. **This file cannot be pushed by
   this lane** — GitHub rejects it for lack of `workflow` OAuth scope, which has
   now blocked this epic five times. The operator applies it, exactly as they did
   for api-gateway commit `7646cf9`.

⚠️ **Ordering matters.** Adding a name to `ecs/env.names` while the workflow does
not export it makes `build-env-json.sh` inject an empty string. For these two
that is survivable (both are string fields, and empty simply keeps the publisher
disabled — the current behaviour), but it is **not** survivable in general: an
empty value on a non-string field crashes the container on boot and rolled back a
deploy on 2026-07-31. Land both legs together, or land the workflow first.

Whether to give `RabbitMQURL()` a non-empty default is a judgement call — a
default pointing at a broker that does not exist in the container's network would
trade a silent no-op for noisy connection retries. Prefer keeping empty-means-
disabled and fixing the plumbing; if you disagree, say why.

## Acceptance criteria

- Both legs landed; a staging deploy shows the Order container with a non-empty
  `RABBITMQ_URL` and no `publisher disabled` line.
- **Live proof**: perform an e-voucher grant on staging, then read
  `GET /api/v1/admin/audit-events?actions=order.redemption_item.grant` and see the
  row, carrying `after.voucher_name` and `after.valid_until` (TASK-EAR-219).
- 🔴 **Re-run the code-leak check against that real row** — every key of
  `before`/`after` plus `reason`, confirming no redeemable voucher code and no
  invented `send_via`-like key. This is the check TASK-EAR-219 could not complete.
- State explicitly whether prod needs the same change and whether it was made.

## Out of scope

- Any change to the audit event's contents (shipped in #26 and #30).
- FE wiring of the E-Voucher scope — blocked on this, tracked in TASK-EAR-222.

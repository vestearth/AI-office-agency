# TASK-EAR-331 — Stop the boot-time migration runner burning pg_attribute slots on every replay

## Type

bugfix (latent production defect; `fix` commit prefix)

## Workstream

backend

## Priority

high

## Created

2026-09-07

## Parent / Epic

- Parent: none
- Epic: none
- Sequence: 1 of 1
- Discovered while running the TASK-EAR-329 gate 3 integration suite. PR
  SparqLab/Games-Labs-Order#55 documents the finding and deliberately does not
  fix it.

## Goal

`migrations.Run` has no version table, so every boot replays all 41 migrations.
Two pairs of migrations undo each other across that replay, adding and then
dropping columns on every single boot. Postgres counts a dropped column against
the hard per-table limit of **1600 attributes permanently** — `VACUUM FULL` does
not reclaim an attnum, only a table rewrite does — so each boot spends
irrecoverable slots. A table that reaches 1600 rejects every further
`ALTER TABLE ... ADD COLUMN` with `SQLSTATE 54011`, and no future migration on
that table can ever succeed.

Make a steady-state boot perform **zero** schema churn, without deleting any
historical migration and without changing the schema a fresh database converges
to.

## Measured exposure

### Staging — measured 2026-09-07

Against `10.80.134.150:5432/gamelabs` (host and credentials read from the
`games-labs-order-staging:75` ECS task definition; the DB is reachable from the
operator network):

| table | dropped | total |
|---|---|---|
| `redemption_items` | **450** | **482** |
| `mission_config` | 240 | 268 |
| `order_packages` | **75** | **98** |
| `wallets` | 56 | 65 |
| `wallet_transactions` | 28 | 40 |

`redemption_items` is at 482 of 1600. The ratio is exact: 450 = 6 per boot ×
75 boots, and 75 = 1 per boot × the same 75 boots.

**Not an incident.** Nothing is near the ceiling, and once this fix ships growth
is zero. `mission_config` at 240 dropped is the *same defect in another service*
sharing the same database — Games-Labs-Missions owns it and it needs its own
task.

### Production — could not be measured

Three independent blockers, all verified:

- `POSTGRES_HOST` for `games-labs-order-prod:18` is
  `database-1.cn2ugmas4dnc.ap-southeast-1.rds.amazonaws.com`, which resolves to
  `10.90.134.49` and is unreachable from the operator network (staging's
  `10.80.x` is reachable; prod's `10.90.x` is not).
- Prod credentials come from Secrets Manager. The `vestearth` profile is denied
  `secretsmanager:ListSecrets`, `ssm:DescribeParameters` and
  `rds:DescribeDBInstances`.
- **Every service in `sparqlab-production-ecs` is scaled to `desiredCount: 0`** —
  order, auth, user, game, wallet, missions, provider, logs and api-gateway. Prod
  Order is not booting at all, so its exposure is *frozen* at whatever it reached
  when it last ran, not growing nightly. `enableExecuteCommand` is `false` on the
  prod service, so ECS exec is not an option either.

Operator: run this from anything inside the prod VPC to close the gap. It is
read-only.

```sql
SELECT c.relname,
       count(*) FILTER (WHERE a.attisdropped) AS dropped,
       count(*) AS total
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND a.attnum > 0
GROUP BY 1 ORDER BY 3 DESC LIMIT 10;
```

If prod `redemption_items` comes back above roughly 1400, treat it as an
incident and do the rebuild below *before* the next scale-up, because the
service cannot boot past a failing migration.

## Root cause

Broader than first reported — there are **two** fighting pairs, seven slots per
boot:

1. `014_align_redemption_proto_schema.sql` adds
   `player_quota_condition_1/2/3` and `limit_day_per_player_1/2/3`;
   `018_simplify_redemption_item_quota_columns.sql` drops all six. **6 per boot.**
2. `003_extend_order_packages.sql` adds the legacy slug column
   `order_packages.code` unconditionally; `008_uuid_id_and_code_name.sql` folds it
   into `code_name` and drops it whenever it exists. **1 per boot.**

Each migration is idempotent in isolation. Only the replay makes them fight.
`orders` carries a single tombstone from the one-time 008 rewrite and is stable.

## Fix

Additive and minimal. No migration is deleted, renumbered, or has a `DROP`
removed — a fresh database must still converge on the same final schema, and a
replay must not care how far along a given database is.

Each offending `ADD COLUMN` group is wrapped in a `DO` block keyed on the marker
column its *successor* migration creates:

- 014's six numbered columns run only while `player_quota_condition` is absent
  (only 018 creates it).
- 003's `code` runs only while `code_name` is absent (only 008 creates it).

On a fresh database the marker is absent when the earlier migration runs, so the
columns are still added and the later migration still drops them — one legitimate
one-time cycle. On any already-migrated database the marker is present, the adds
are skipped, and the drops are the no-ops they were always meant to be.

## Acceptance criteria — all verified

1. Fresh guarded database vs fresh unguarded database: `information_schema.columns`
   and `pg_indexes` diff **identical** — 241 columns, 65 indexes.
2. Second `migrations.Run` against an already-migrated database: **zero** change
   in dropped and total attributes on every public table.
3. Same against a database already carrying churn tombstones
   (`redemption_items` 12/44, `order_packages` 3/26): unchanged after two guarded
   runs, and its live schema still matches the fresh-guarded one.
4. The new regression test was **seen failing** on the unguarded migrations —
   `redemption_items dropped columns = 12 after replay, want 6`,
   `order_packages ... = 3 ..., want 2` — and passes on the guarded ones.
5. A full integration suite run adds **0** tombstones where it previously added
   192 (32 harness setups × 6).
6. `GOWORK=off go build ./...`, `go vet ./...`, `go test ./...` all pass; the
   integration suite passes against a real Postgres.

## Regression test

`tests/integration/migration_replay_test.go` runs `migrations.Run` twice against
the real Postgres named by `ORDER_TEST_DATABASE_URL` and asserts that no table in
`public` gains dropped *or* total attributes between the passes.

The first pass is deliberately exempt — bringing an empty or legacy database up
to date is allowed to drop columns, exactly as a first boot is. Only the steady
state has to be inert. `redemption_items` is asserted by name as well as through
the whole-schema sweep, because it is the table that actually hit the ceiling.

## Out of scope — for the operator to decide

### Reclaiming the tombstones already accrued

The fix stops growth; it does not reclaim what is already spent. Staging
`redemption_items` stays at 450 dropped of 482, i.e. 482 of the 1600 budget. That
is ample headroom now that growth is zero, so **the recommendation is to do
nothing on staging for now** and revisit only if a future bulk column change eats
the remainder.

`VACUUM FULL` will not help — it rewrites the heap but preserves attnums.
Reclaiming needs a genuine table rebuild. **Do not execute any of this from this
run**; it is written down so the operator can schedule it:

- **Option A — `pg_dump` / restore of the single table (recommended).** Dump
  `redemption_items` data only, drop and recreate the table from the migration
  DDL, restore. Resets attnums to the live column count (32). Needs a maintenance
  window: the table is unavailable throughout, and every FK referencing it must be
  dropped and recreated.
- **Option B — shadow table and swap.** `CREATE TABLE redemption_items_new
  (LIKE redemption_items INCLUDING ALL)` — `LIKE` copies only live columns, so the
  new table starts clean — `INSERT INTO ... SELECT`, then rename inside one
  transaction. Shorter lock, but FKs, sequences and grants must be moved by hand.
- **Option C — do nothing.** Correct while headroom is large and growth is zero.

Whichever is chosen, run it **after** this fix is deployed, or the very next boot
starts spending slots again.

### `mission_config` in Games-Labs-Missions

240 dropped of 268 in the *same* staging database, from the same replay pattern
in a different service. Needs its own task against Games-Labs-Missions.

### The structural fix

A migration version table (or `golang-migrate`) would make this class of bug
impossible rather than guarded case by case. Deliberately not attempted here —
it changes boot semantics for a service whose migrations are all currently
required to be idempotent, and it deserves its own task rather than riding along
with an urgent churn fix.

## Delivery

PR against `staging` on `task/TASK-EAR-331-migration-column-churn`. **The run
stops at the open PR** — the operator merges, and for this repo merging is the
deploy.

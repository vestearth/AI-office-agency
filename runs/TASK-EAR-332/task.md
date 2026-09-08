# TASK-EAR-332 — Stop Missions boot replay burning mission_config attnum slots

## Type

bugfix (`fix` commit prefix)

## Workstream

backend

## Priority

high

## Created

2026-09-07

## Parent / Epic

- Parent: TASK-EAR-331 (Order sibling; merged as Games-Labs-Order PR 56)
- Epic: none
- Sequence: 1 of 1 for Games-Labs-Missions

## Goal

`migrations.Run` replays every embedded SQL file on every process boot with no
version table. Migration 011 `ADD COLUMN IF NOT EXISTS` two `mission_config`
columns that 013 `DROP`s, so each boot burns two PostgreSQL attnum slots
forever. VACUUM FULL does not reclaim them; SQLSTATE 54011 at 1600.

Make a steady-state Missions boot perform **zero** schema churn on
`mission_config`, without deleting 013 and without changing the live schema a
fresh database converges to.

**Out of scope:** Wallet 004/006 (already versioned via `wallet_schema_migrations`;
staging `wallets` 56/65 is frozen residue). Table rewrite to reclaim existing
tombstones. Games-Labs-Order (already shipped).

## Measured exposure

Staging shared `gamelabs` (2026-09-07, operator query):

| table | dropped | total |
|---|---|---|
| `mission_config` | **240** | **268** |

240 / 2 = 120 Missions boots of this pair. Not an incident (1332 headroom) but
still growing until this ships.

## Acceptance

- [ ] 011 only ADDs `mission_boost_pass_price_coin` and
      `mission_boost_pass_duration_hours` while `mission_boost_normal_reward`
      is absent (pre-011 shape). 013's DROP is unchanged.
- [ ] A second `migrations.Run` adds zero dropped and zero total attributes on
      every public table, including `mission_config`.
- [ ] The two-pass replay test fails on unguarded 011 and passes on guarded 011.
- [ ] `GOWORK=off go build ./...`, `go vet ./...`, and `go test ./...` pass.
- [ ] PR against `staging`. Operator merges; merging deploys.

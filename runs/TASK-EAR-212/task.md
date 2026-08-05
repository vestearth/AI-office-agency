# TASK-EAR-212: Retire Missions `store_packages` table

## Type

refactor

## Workstream

backend

## Priority

medium

## Created

2026-08-05

## Goal

Permanently retire Games-Labs-Missions local `store_packages` catalog. Deployed
envs already use Order (`USE_ORDERS_CATALOG=true`). Stop recreating/seeding the
table on every boot, drop it, remove repository package CRUD, and fail-closed
when the Orders catalog path fails (no silent local-table fallback).

Keep `StoreRepository` ownership / purchase / `exchange_rates` paths intact.

## Acceptance criteria

- Boot no longer leaves a `store_packages` table (replay-safe DROP; baseline no
  longer CREATE/seed that table).
- No Go code queries or writes `store_packages`.
- With `USE_ORDERS_CATALOG=true`, package list/get use Order only; Order errors
  do not fall back to a local DB catalog.
- Local `USE_ORDERS_CATALOG=false` may keep in-memory seed only (no DB table).
- Focused tests cover Orders-catalog path and no-repo package fallback.
- `go test` for affected store packages passes.

## Out of scope

- Retiring `exchange_rates` local table / Wallet rate catalog.
- Changing Order `order_packages` schema or Backoffice.
- Forcing `USE_ORDERS_CATALOG=true` as the only local default (optional later).

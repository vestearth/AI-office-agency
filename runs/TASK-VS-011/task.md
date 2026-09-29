# TASK-VS-011 — Serialize slip-api boot migrations across replicas

## Problem
slip-api runs goose migrations on every task boot (migrations.Run) with no
cross-replica lock. On the 2026-09-28 prod deploy (TASK-VS-010, PR #27) three
tasks ran data migration 046 concurrently: two died with deadlock 40P01, one
committed. A non-deadlocking waiter could have re-applied a non-idempotent
data migration.

## Scope
- Run migrations through a goose Provider with the Postgres session locker
  (pg advisory lock) so only one replica migrates at a time.
- Regression test: concurrent runs apply a migration exactly once, seen failing
  before the fix.

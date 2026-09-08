# TASK-EAR-334 — Migration/schema drift audit across the backend services

## Why

TASK-EAR-333 gate 4 built an Auth database from scratch and it did not work.
`users.soft_deleted_at` is read and written in eight places in
`internal/core/repositories/auth.go`; no file in `migrations/*.sql` creates it.
The deployed databases have the column — added out-of-band — so the gap was
invisible. A new staging, a restore, or a local dev database fails on every
user query with SQLSTATE 42703.

Repaired in Games-Labs-Auth PR 12 as `migrations/013_users_soft_deleted_at.sql`.

The class is only visible from empty. Several services here replay their entire
embedded migrations directory on every boot, so a fresh environment is exactly
what they would build.

## Scope

Audit for the same drift:

- Games-Labs-User
- Games-Labs-Order
- Games-Labs-Wallet
- Games-Labs-Missions
- Games-Labs-Game
- Games-Labs-Provider

Games-Labs-Auth is the reference case, already repaired. The read-only Android
reference repository is out of scope.

## Method (proof, not grep)

1. `createdb <svc>_drift_test` on the local Postgres.
2. Run that service's own `migrations.Run(ctx, pool)` against the empty database.
3. Check every repository statement against the resulting schema. A statement
   Postgres can PREPARE resolves all of its column references without touching
   data; 42703 names the missing column exactly.
4. Report per service every column the code uses that the migrations do not
   create.

## Deliverables

- Per gap: a repair migration in that service, its own file,
  `ADD COLUMN IF NOT EXISTS` (or equivalent), with a header saying it repairs
  an omission rather than adding a feature. Type derived from the Go model; the
  PR states when a type was inferred because the original DDL is unknown.
- Per service: a regression test in the style of
  `Games-Labs-Auth/migrations/account_source_migration_test.go` — migrations
  against a fresh database, then assert the repository column lists resolve.
- Columns whose type cannot be determined are reported for the operator, never
  guessed.

## Constraints

- Backend PRs target `staging`. Do not merge — the operator merges, and merging
  is the deploy.

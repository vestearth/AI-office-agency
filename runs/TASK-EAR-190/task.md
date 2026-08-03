# TASK-EAR-190 — Goose lane: guard 006 so `make migrate-up` can bootstrap a fresh database

## Type

fix

## Priority

medium

## Context

The "Known residue" flagged in TASK-EAR-189's audit.md: the manual goose lane
(`make migrate-up` → `scripts/goose/main.go` → goose binary over
`migrations/`) cannot bootstrap a truly fresh database. Goose applies files in
numeric order, and `006_migrate_game_status_enum.sql` contains an unguarded

    UPDATE games SET status = CASE WHEN is_active = true ...

but `is_active` is a legacy column that the current `001_games_table.sql` no
longer creates (001 now creates the `game_status` enum and `status` column
directly). So `goose up` on an empty database fails at 006 with
`column "is_active" does not exist`. TASK-EAR-189 fixed the boot-time lane
(`migrations.Run`) only and deliberately left this untouched.

## Decision: guard 006, keep the goose lane

Two options were on the table — guard 006's UPDATE on the existence of
`is_active`, or retire the goose lane entirely. **Guard.** The goose lane is
still the only lane that applies one-shot data backfills to live databases:
`migrations.Run` deliberately skips 004/005/006/008/014/015/020 (see run.go's
header), and 020-style one-time backfills can never be embedded in a
replay-every-boot runner. Retiring goose would orphan that capability and is a
team-level tooling decision far beyond this fix.

Rule compliance (schema-change-needs-migration): "never edit an applied
migration" forbids changing an applied migration's *meaning*. A pure existence
guard preserves meaning exactly:

- Everywhere live, goose tracks 006 by version in `goose_db_version` and never
  re-runs it — the edited text is never executed there.
- On any database where 006 *does* run fresh, `games.is_active` does not exist
  (001 no longer creates it), so the original UPDATE could never have executed
  anyway — it only ever errored. The guard makes the unreachable branch
  skip cleanly instead of crashing; on a hypothetical legacy DB that still has
  `is_active`, the branch runs the identical UPDATE.

## Scope — Games-Labs-Game only

1. Wrap 006's UPDATE in a `DO $$` block guarded on
   `information_schema.columns` for `games.is_active` — the exact guard
   pattern already used in 011/018/022/031. The UPDATE text inside the branch
   stays byte-identical. PL/pgSQL only plans a statement when its branch is
   taken, so the stale column reference is never planned on fresh DBs (the
   same mechanism 011's guarded legacy branch relies on).
2. Freshen the one now-stale line in `migrations/run.go`'s header comment
   (006 "would crash every boot" — after the guard it would no-op, but
   embedding it still adds nothing; 001 already creates the enum + status).
   006 stays NOT embedded.
3. **Regression test** (test-integrity rule): `migrations/goose_lane_test.go`
   — replays every `migrations/*.sql` Up section in numeric file order
   against a scratch database created from `GAME_TEST_DATABASE_URL`,
   simulating the goose lane's fresh `goose up` ordering semantics. Seen RED
   at 006 before the fix, GREEN after.
4. Verify with the real goose binary against a disposable Postgres 16
   container: `goose up` from empty fails at 006 pre-fix, completes through
   032 post-fix; record evidence in audit.md.
5. Full pass: `go build ./... && go vet ./... && go test ./...` with
   `GAME_TEST_DATABASE_URL` set.

## Scope addendum (found during implementation)

Real-goose verification surfaced a second fresh-bootstrap blocker beyond the
flagged 006: `031_games_category_fk.sql`'s DO block has no goose
StatementBegin/End annotations, so goose splits it at internal semicolons
and fails to parse (SQLSTATE 42601) — meaning 031 was never applicable via
`make migrate-up` anywhere; every environment got the FK from the boot lane.
In scope: add the annotations (parser directives in SQL comments — inert to
the boot lane, no semantic change) and extend the regression test with a
static DO-annotation invariant, since the pgx-based replay cannot see
goose's statement splitting.

## Non-goals

- No change to which files `migrations.Run` embeds (189's audit stands).
- No change to 006's Down section (already fully guarded; meaning untouched).
- No retiring/reworking of the goose wrapper or Makefile targets.
- api-gateway, Provider, FE: untouched.

## Acceptance criteria

- Real `goose up` completes 001→032 on a completely empty Postgres 16
  database; final schema has `games.status` (game_status enum) and no
  `is_active`.
- Regression test RED-first evidence recorded; test passes post-fix.
- 006's edited Up section is provably meaning-preserving (argument above,
  restated in audit.md).
- Full build/vet/test green.

## Deploy order and rollback

- Single repo, single PR; branch stacked on
  fix/TASK-EAR-189-migrations-fresh-bootstrap (unpushed local 3a3f739) since
  it fixes that run's flagged residue — merge 189 first, or together.
- Deploy order: no live database executes the edited text (goose tracks 006
  as applied everywhere live; the boot lane never embeds it), so there is no
  code/schema ordering constraint at all.
- Rollback: revert the commit. Forward-only in effect; 006's Down section is
  unchanged.

# TASK-EAR-189 — Fresh-DB bootstrap: wire missing migrations into Games-Labs-Game boot sequence

## Type

fix

## Priority

high

## Context

Surfaced during TASK-EAR-187 (see that run's status.yaml handoff note): the
TASK-EAR-187 real-Postgres harness proved a truly fresh database cannot boot
via `migrations.Run` — it fails at `026_categories_name_jsonb.sql` because
`categories` (created by `010_create_categories_table.sql`, which exists on
disk but was never embedded) does not exist. Live environments only work
because they received the goose-era migrations 004–020 historically. The
harness papered over it by pre-creating `categories` by hand
(`round_win_amount_db_test.go`), explicitly flagged as a workaround for a
pre-existing gap, not a fix.

`migrations/run.go` embeds and executes 15 of the 30 SQL files on disk
(002/003 no longer exist). Missing from the boot sequence: 004, 005, 006,
008, 009, 010, 011, 013, 014, 015, 016, 017, 018, 019, 020.

The repo replays EVERY embedded migration on EVERY boot with no version
table (see 031's header comment), so anything wired in must be idempotent
AND replay-safe against both a fresh DB and the current live schema.

## Scope — Games-Labs-Game only

1. **Audit** all 15 unwired files: required for fresh bootstrap vs net no-op
   vs actively dangerous to replay. Document the decision per file.
2. **Wire in the required ones** in numeric order, guarding any statement
   that is not replay-safe (repo precedent: 022's information_schema guards,
   031's pg_constraint DO block).
3. **Do NOT wire in** one-shot transitional migrations whose replay would
   destroy live data (e.g. 014 re-dropping `games.is_new/is_hot` that 018
   recreates — silent flag wipe every boot) — document why each is skipped.
4. **Regression test** (test-integrity rule): a fresh-bootstrap test in
   `migrations/` that runs `migrations.Run` twice against a disposable
   Postgres 16 from empty, seen RED on current staging before the fix, GREEN
   after. Must also prove replay preserves data (insert rows between the two
   runs and assert they survive — catches the 011 `DELETE FROM
   category_games` class of hazard).
5. Remove the now-dead `categories` pre-create workaround from the
   TASK-EAR-187 harness so those tests also exercise true fresh bootstrap.
6. Full pass: `go build ./... && go vet ./... && go test ./...`, plus the
   DB-backed suite against disposable Postgres 16 with
   `GAME_TEST_DATABASE_URL` set.

## Non-goals

- No new schema. No changes to what live databases end up containing — every
  wired-in migration must be a provable no-op against the current live shape.
- No changes to 020's data backfill semantics: it is a one-time sync already
  applied everywhere live, a no-op on fresh (empty tables), and replaying it
  every boot would silently overwrite `games.level` drift — skip it, do not
  "fix" it.
- api-gateway, Provider, FE: untouched.

## Acceptance criteria

- `migrations.Run` succeeds twice from a completely empty Postgres 16
  database; second run is a no-op that preserves rows inserted between runs.
- Final fresh schema matches live expectations: `categories` (name JSONB,
  is_highlight, image_url), `category_games` (category_id NOT NULL + unique
  index), `level_groups`/`level_group_games` (+ unique game index),
  `games.is_new/is_hot` (+ exclusivity constraint).
- Live-DB safety argued file by file: each newly wired migration is a no-op
  against the current staging schema.
- RED-first evidence for the bootstrap regression test.
- Audit table (all 15 files → wired / skipped, with reason) recorded in the
  run.

## Deploy order and rollback

- Single repo, single PR (base staging per the staging-forward pattern).
  Migration changes and code ship together; the migration runner IS the app
  boot, so deploy order is trivially "the deploy".
- Rollback: revert the commit. Newly wired migrations only CREATE
  IF-NOT-EXISTS objects that live DBs already have; reverting reintroduces
  no drift.

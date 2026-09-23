# TASK-EAR-200 — Secure staging ClickHouse access without stopping Monitoring ingestion

## Type

devops

## Priority

critical — staging ClickHouse still accepts unauthenticated public reads;
the service-side guard must be deployed without interrupting Monitoring.

## Direction — SUPERSEDED 2026-08-01, CORRECTED 2026-09-21

### Current direction (operator, 2026-09-21)

**Keep ClickHouse on staging; secure it.** Monitoring player-activity is in
active use and has **no PostgreSQL path** — `monitoring_player_events`,
`monitoring_round_outcomes`, `monitoring_projection_coverage`,
`monitoring_game_player_daily` and the two ingest-proof tables exist only in
ClickHouse, and `cmd/main.go` silently disables the player-activity consumer
when the projector is nil. The operator confirmed on 2026-09-22 that staging
already has an explicit `CLICKHOUSE_USERNAME` and intentionally does not set
`CLICKHOUSE_PASSWORD`; the network firewall is therefore the primary security
boundary. The work is to restrict 8123/9000 to the approved ECS/admin sources
and prevent hidden address/username fallbacks without imposing a password that
the operator did not choose. **Not** "switch to PostgreSQL-only".

Prod already has this shape: a private `10.90.x` address with a real
credential, enforced at deploy time by TASK-EAR-308 (PR #33).

### What the 2026-08-01 direction said, and why it no longer holds

The v2 direction was "Use PostgreSQL only for now; prepare for a ClickHouse
migration in a later round", resting on this safety claim:

> ClickHouse holds nothing PostgreSQL lacks. `multi_logs_repo.go:34-37` writes
> PostgreSQL as source of truth and treats CH errors as log-and-ignore.

That was accurate **for the `logs` dual-write** and is still accurate for it.
It is **not** accurate for the service as a whole any more: Monitoring was
built directly on ClickHouse afterwards (TASK-EAR-343, TASK-EAR-346, Aug-Sep
2026) and nobody revisited this paragraph. Acting on it — clearing
`CLICKHOUSE_ADDR` — would have stopped Monitoring ingestion with one log line
and no error. Recorded here rather than deleted, because the stale claim was
repeated into a PR before it was caught.

## The exposure being closed (unchanged from v1)

ClickHouse at 84.247.150.206:8123 (+9000) accepts unauthenticated
`default`-user reads from the public internet; ~54k rows of raw provider
bodies since 2026-03-16. Proven by the 2026-07-31 probe. Root causes:
hardcoded public-IP default in `infrastructures/clickhouse.go:19,24` with
silent `default`-user fallback; the VPS serving 8123/9000 to 0.0.0.0.

## Work breakdown

### Operator-executed (REVISED 2026-09-21 — the instance stays up)

1. **Restrict 8123/9000 to the approved ECS/admin sources** on the VPS.
   Do NOT stop or wipe the server: Monitoring player-activity reads and writes
   it and has no PostgreSQL fallback. Keep the explicitly configured staging
   `CLICKHOUSE_USERNAME`; an empty `CLICKHOUSE_PASSWORD` is intentional per
   the operator, not a missing secret. Security acceptance therefore depends
   on the external ports becoming unreachable from unapproved sources.

### Claude-lane (Games-Labs-Logs repo, implemented but not merged/deployed)

2. **`infrastructures/clickhouse.go`** — IMPLEMENTED on draft Games-Labs-Logs
   PR #35 and re-verified 2026-09-22 with `go test ./...`, but not yet merged or
   deployed. Remove the hardcoded public-IP default address. Unset/empty
   `CLICKHOUSE_ADDR` = ClickHouse disabled — note this disables Monitoring
   too, so it is a development posture, not the staging one —
   which instantly makes every lane Postgres-only without touching the
   dual-write seam. Add the future-proofing guard while in there: if an
   address IS configured and is non-localhost, **require an explicitly
   configured username** and never invent an address or user. Do not require a
   non-empty password for staging: that conflicts with the operator-approved
   passwordless policy.
3. **Revise PR #35 guard and tests before merge.** The current branch requires
   both username and password and explicitly rejects username-only remote
   targets, so it would refuse to boot with the intended staging config.
4. **Correct PR #35 README before merge.** Its current PostgreSQL-only text
   still repeats the superseded claim that ClickHouse holds no unique data
   and that clearing `CLICKHOUSE_ADDR` is a safe staging posture. That is
   false for the Monitoring-only tables and contradicts the current direction
   above; the code guard itself is still valid.
5. **Merge/deploy after the firewall and guard corrections.** The workflow
   already reads ClickHouse settings from the GitHub environment; preserve the
   intentional username-only staging configuration.
6. **Tests**: empty addr = disabled; remote addr without an explicit username
   = boot error; remote addr with an explicit username and empty password
   passes the config guard; localhost without either remains allowed for dev.

### Verification

7. After the firewall and code deploy: Logs boots clean against ClickHouse
   with the configured username and intentional empty password, and Monitoring
   player-activity ingestion continues with new events.
8. After the operator firewalls the server: external probe of
   84.247.150.206:8123 fails (connection refused/timeout) — evidence
   captured in this run.

## Later-round migration notes (recorded now, executed then)

- Backfill = copy from Postgres (source of truth), time-partitioned per
  the 181 notes; no rescue needed from the old CH data.
- Re-enable path requires an explicit remote address and username by
  construction (step 2's corrected guard); a password remains optional.
- Retention/TTL decisions ride the TASK-EAR-181 retention work, not this
  run.

## Acceptance criteria (REVISED 2026-09-21)

- No committed file carries the public IP; missing config can never silently
  fall back to `default`@public-addr. **IMPLEMENTED AND TESTED on draft
  Games-Labs-Logs PR #35, but not merged or deployed; its README must be
  corrected before merge.**
- **External unauthenticated read fails.** Re-probe `84.247.150.206:8123` and
  `:9000` from outside AWS and capture the refusal. STILL OPEN, and this is
  the acceptance-critical item: as of 2026-09-22 both ports accept TCP and
  `GET :8123/?query=SELECT%201` returns HTTP 200 with no credentials.
- Staging Logs boots against ClickHouse with the explicitly configured
  username and intentional empty password, and
  **Monitoring player-activity keeps ingesting** — prove ingestion continues
  after the firewall/config change rather than assuming it, since a failed
  projector disables the consumer with only a log line.
- SUPERSEDED: "all lanes provably PostgreSQL-only", and the deferred-migration
  intent. ClickHouse is staying on staging. The backfill-from-PostgreSQL notes
  above survive only as a disaster-recovery sketch for the `logs` tables, and
  do not cover the Monitoring tables, which have no PostgreSQL source.

# TASK-EAR-200 — Logs goes Postgres-only; retire the public ClickHouse dual-write (CH migration deferred to a later round)

## Type

devops

## Priority

critical — the exposure part; the Postgres-only switch itself is low-risk.

## Direction — SUPERSEDED 2026-08-01, CORRECTED 2026-09-21

### Current direction (operator, 2026-09-21)

**Keep ClickHouse on staging; secure it.** Monitoring player-activity is in
active use and has **no PostgreSQL path** — `monitoring_player_events`,
`monitoring_round_outcomes`, `monitoring_projection_coverage`,
`monitoring_game_player_daily` and the two ingest-proof tables exist only in
ClickHouse, and `cmd/main.go` silently disables the player-activity consumer
when the projector is nil. The work is therefore: put real credentials on the
instance, restrict 8123/9000 to the VPC/admin, and make the service refuse a
credential-less remote target. **Not** "switch to PostgreSQL-only".

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

1. **Restrict 8123/9000 to the VPC/admin** on the VPS, and **set a real
   ClickHouse user and password** (never `default` with an empty password).
   Do NOT stop or wipe the server: Monitoring player-activity reads and writes
   it and has no PostgreSQL fallback. Then add the matching
   `CLICKHOUSE_USERNAME` / `CLICKHOUSE_PASSWORD` secrets to the `staging`
   GitHub environment on Games-Labs-Logs — they do not exist today, which is
   why the task definition currently renders `default` / empty. Claude
   prepares the exact commands on request once you confirm how CH runs there
   (docker compose vs systemd).

### Claude-lane (Games-Labs-Logs repo, PR-able now, ordering-safe)

2. **`infrastructures/clickhouse.go`** — DONE 2026-09-21, Games-Labs-Logs PR
   #35. Remove the hardcoded public-IP default address. Unset/empty
   `CLICKHOUSE_ADDR` = ClickHouse disabled — note this disables Monitoring
   too, so it is a development posture, not the staging one —
   which instantly makes every lane Postgres-only without touching the
   dual-write seam. Add the future-proofing guard while in there: if an
   address IS configured and is non-localhost, **require credentials or
   fail loud at boot** (no silent `default`-user fallback ever again).
3. **Keep the seam for the later round** (per 181's recorded consequence):
   `clickhouse_logs_repo.go` + `multi_logs_repo.go` stay in the tree
   unused, with a short code comment stating Postgres is the live path and
   re-enabling requires explicit addr + credentials.
4. **Workflow/env hygiene**: drop the committed public-IP defaults from
   `.github/workflows/staging.yml:105-108` + `prod.yml`; CH env entries in
   `ecs/env.names` may stay (they render "" when unset → disabled, which
   is now the safe path by construction — keep them strings per the
   env.names lesson). k3s manifest: ask the operator whether the EKS lane
   still runs Logs; add the same disabled-by-default posture or delete the
   stale manifest accordingly.
5. **README/service docs**: state Postgres-only + the deferred-migration
   intent and the backfill-from-Postgres plan sketch (time-partitioned
   copy), so the later round starts from a written intent instead of
   archaeology.
6. **Tests**: config guard (empty addr = disabled; remote addr without
   creds = boot error; localhost without creds = allowed for dev).

### Verification

7. After the code deploys: Logs service boots clean with CH disabled (no
   `[clickhouse]` init/error lines), Postgres writes continue
   (`provider_outbound_events` advancing on staging).
8. After the operator stops/firewalls the server: external probe of
   84.247.150.206:8123 fails (connection refused/timeout) — evidence
   captured in this run.

## Later-round migration notes (recorded now, executed then)

- Backfill = copy from Postgres (source of truth), time-partitioned per
  the 181 notes; no rescue needed from the old CH data.
- Re-enable path is credential-required by construction (step 2's guard).
- Retention/TTL decisions ride the TASK-EAR-181 retention work, not this
  run.

## Acceptance criteria (REVISED 2026-09-21)

- No committed file carries the public IP; missing config can never silently
  fall back to `default`@public-addr. **DONE — Games-Labs-Logs PR #35.**
- **External unauthenticated read fails.** Re-probe `84.247.150.206:8123` and
  `:9000` from outside AWS and capture the refusal. STILL OPEN, and this is
  the acceptance-critical item: as of 2026-09-21 both ports accept TCP and
  `GET :8123/?query=SELECT%201` returns HTTP 200 with no credentials.
- Staging Logs boots against ClickHouse with a real username and password, and
  **Monitoring player-activity keeps ingesting** — prove ingestion continues
  after the credential change rather than assuming it, since a failed
  projector disables the consumer with only a log line.
- SUPERSEDED: "all lanes provably PostgreSQL-only", and the deferred-migration
  intent. ClickHouse is staying on staging. The backfill-from-PostgreSQL notes
  above survive only as a disaster-recovery sketch for the `logs` tables, and
  do not cover the Monitoring tables, which have no PostgreSQL source.

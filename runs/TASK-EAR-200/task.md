# TASK-EAR-200 — Logs goes Postgres-only; retire the public ClickHouse dual-write (CH migration deferred to a later round)

## Type

devops

## Priority

critical — the exposure part; the Postgres-only switch itself is low-risk.

## Direction (operator, 2026-08-01 — supersedes this run's v1 scope)

**Use Postgres only for now. Prepare for a ClickHouse migration in a later
round.** This aligns with the recorded TASK-EAR-181 decision ("Postgres
first; ClickHouse stays the right shape if volume later justifies it;
nothing new gets provisioned or operated now") — the live dual-write
predates that decision (added 2026-03-20, e32df05) and was never
re-evaluated against it.

Safety fact making this clean: **ClickHouse holds nothing Postgres lacks.**
`multi_logs_repo.go:34-37` writes Postgres as source of truth and treats CH
errors as log-and-ignore — CH is a strict best-effort mirror. Stopping (or
even wiping) CH loses zero data; the future migration is a backfill/copy
from Postgres.

## The exposure being closed (unchanged from v1)

ClickHouse at 84.247.150.206:8123 (+9000) accepts unauthenticated
`default`-user reads from the public internet; ~54k rows of raw provider
bodies since 2026-03-16. Proven by the 2026-07-31 probe. Root causes:
hardcoded public-IP default in `infrastructures/clickhouse.go:19,24` with
silent `default`-user fallback; the VPS serving 8123/9000 to 0.0.0.0.

## Work breakdown

### Operator-executed (one action now instead of v1's four)

1. **Stop the ClickHouse server on the VPS** (or, minimum, firewall
   8123/9000 to admin-only). Recommended: stop the container/service and
   leave the data directory in place — zero exposure, nothing listening,
   disk kept for reference until the later-round decision (though the data
   is redundant with Postgres, so deletion is also safe whenever disk
   space matters). Claude prepares the exact commands on request once you
   confirm how CH runs there (docker compose vs systemd).

### Claude-lane (Games-Labs-Logs repo, PR-able now, ordering-safe)

2. **`infrastructures/clickhouse.go`**: remove the hardcoded public-IP
   default address. Unset/empty `CLICKHOUSE_ADDR` = ClickHouse disabled —
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

## Acceptance criteria

- All lanes provably Postgres-only (boot logs + no CH connections).
- No committed file carries the public IP; missing config can never
  silently fall back to `default`@public-addr.
- External unauthenticated read fails (evidence).
- The migration-later intent + backfill sketch is written down (step 5).

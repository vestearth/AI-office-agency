# TASK-EAR-200 — Lock down publicly readable ClickHouse on the Logs VPS

## Type

devops

## Priority

critical — live data exposure, not a hypothetical: unauthenticated public
reads were actually performed (read-only) during the 2026-07-31 GGSoft
correlation probe.

## The exposure (all evidence file:line-verified this week)

ClickHouse at **84.247.150.206:8123** (HTTP; native 9000 presumed open too)
accepts **unauthenticated `default`-user SELECTs from the public internet**.
It holds `gameslabs.logs_gameslabs` — ~54,476 rows of raw provider HTTP
request/response bodies (player ids, bet/win amounts, session/token
material inside bodies) dating back to 2026-03-16, still receiving writes.

Why it's open:

- `Games-Labs-Logs/infrastructures/clickhouse.go:19,24` — **hardcodes the
  public VPS IP as the default address** and falls back to user `default` /
  empty password when `CLICKHOUSE_USERNAME`/`PASSWORD` are unset.
- `Games-Labs-Logs/ecs/env.names:13-14` — username/password ARE plumbed in
  the ECS lane (values live in GitHub secrets; whether real values are set
  is unverified).
- `Games-Labs-Logs/k3s/deployment.yaml` — username/password **absent** in
  the EKS/k3s lane → that lane always connects as `default`.
- `.github/workflows/staging.yml:105-108` + `prod.yml` — committed defaults
  point at the same public address.
- The server itself (Contabo VPS 84.247.150.206 — the old Provider
  docker-compose host, TASK-097 era) exposes 8123 to 0.0.0.0 with the
  `default` user unrestricted.

Risk note for ordering: ClickHouse is a **best-effort dual-write** — the
Logs service treats CH errors as log-and-ignore
(`internal/core/repositories/multi_logs_repo.go:34-37`), Postgres is the
source of truth. So locking CH down cannot break money paths; brief CH
write failures are tolerable. Any change window works.

## Work breakdown — two hands

### Operator-executed (needs VPS SSH root + GitHub secrets write; Claude
### prepares exact snippets, cannot execute)

1. **Create a real ClickHouse user** (e.g. `logs_writer`, strong password)
   with INSERT+SELECT on `gameslabs.*`; optionally a separate `logs_reader`
   (SELECT-only) for future tooling.
2. **Neuter the `default` user**: users.d override — no password ≠ no
   access anymore: restrict `default` to localhost (`<networks><ip>
   127.0.0.1</ip></networks>`) or give it a password and drop remote
   grants. Do NOT delete it (clickhouse internals use it locally).
3. **Firewall**: close 8123 + 9000 to the internet; allow only (a) the ECS
   staging/prod egress IPs (NAT gateway EIPs of `sparqlab-development-ecs`
   and the prod cluster) and (b) operator admin IPs. ufw/iptables/Contabo
   panel — whichever governs that VPS today.
4. **Set GitHub secrets** with the new credentials for Games-Labs-Logs:
   the ECS lane's `CLICKHOUSE_USERNAME`/`CLICKHOUSE_PASSWORD` (staging +
   prod environments), and create the k8s secret for the EKS lane.

### Claude-lane (repo changes, PR-able)

5. **`infrastructures/clickhouse.go`**: remove the hardcoded public-IP
   default — unset address = ClickHouse disabled (the code already
   tolerates nil CH), and **refuse to connect non-localhost without
   credentials** (fail loud at boot with a clear message rather than
   silently connecting as `default`).
6. **`k3s/deployment.yaml`**: add `CLICKHOUSE_USERNAME`/`PASSWORD` from the
   k8s secret (closing the survey gap) — or, if the EKS lane genuinely no
   longer runs Logs, document that and delete the stale manifest instead
   (verify with the operator which is true before choosing).
7. **Workflow defaults** (`staging.yml:105-108`, `prod.yml`): stop
   committing the public IP as a fallback value — require the vars/secrets
   to be set (the ecs-env-names lesson applies: keep values strings, and
   remember unset workflow env renders "" — the accessor must treat "" as
   "CH disabled", which also de-risks the rollout ordering).
8. **Tests**: unit-test the new config guard (non-localhost + no creds =
   boot error; empty address = disabled path unchanged).

### Verification (Claude-lane, after operator applies server-side)

9. From an external vantage (this workstation): `curl
   http://84.247.150.206:8123/?query=SELECT%201` must FAIL (auth error or
   timeout). Authenticated check with the new user must succeed only if
   run from an allowed IP — expect failure from here if the firewall is
   strict (that failure is a PASS).
10. Confirm the Logs service still dual-writes: staging
    `logs_gameslabs`/`provider_outbound_events` row counts advance after a
    provider call (or at minimum no `[clickhouse]` error spam in service
    logs).

## Explicitly out of scope

- Retention/TTL on the CH table (belongs to the TASK-EAR-181 retention
  work), the Postgres side, any incident-response/disclosure decision about
  the historical exposure window (operator's call, flagged here only).

## Acceptance criteria

- External unauthenticated read fails (evidence captured).
- Logs service writes continue with credentials (evidence captured).
- No committed file carries the public IP as an implicit default; missing
  creds can never silently fall back to `default` on a remote address.
- Deploy order + rollback stated in the PR (rollback = re-allow the old
  firewall rule; code change is independently safe because CH is
  best-effort).

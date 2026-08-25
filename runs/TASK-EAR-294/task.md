# TASK-EAR-294 — Align shared-lib pin across all Games Labs repos

## Origin
Multica issue SPAR-10 (Vysser / Claude advisory lane). Drift audit found six
distinct `github.com/SparqLab/shared-lib` pseudo-versions across the eight Go
services plus `api-gateway`, spanning 2026-07-31 to 2026-08-18.

## Target
`v0.0.0-20260820032904-861f0063a895` — shared-lib `origin/main` HEAD
(`861f006`). The only two commits after the previously-newest pin
(`13f9f1541f39`, 2026-08-18) are comment/doc-only
(`cd395f8 docs(adminauth)`), so the wire contract at HEAD is identical to the
version Wallet and api-gateway already run in staging.

## Scope
Games-Labs-{Auth,Game,Logs,Missions,Order,Provider,User,Wallet} + api-gateway.
Per repo: `go get shared-lib@861f006` -> `go mod tidy` -> commit go.mod+go.sum
together -> verify `GOWORK=off go build -mod=readonly ./...` and `go test ./...`.

## Constraints
- No `replace` directives (AGENTS.md).
- go.mod and go.sum committed together.
- Breaking commits inside the bump window: `7cee27b` retires `actor_access`
  (adminlogpb) and `5d8544c` adds field presence to
  `UpdateWalletBalanceRequest` (adminwalletpb) — verify the consuming services
  still compile.
- No push / PR without operator approval.

## Result (2026-08-21)
All 9 repos bumped on branch `chore/TASK-EAR-294-shared-lib-align`, cut from
`staging` (`main` for none — every target repo's default lane here is staging).
Each commit touches only `go.mod` + `go.sum`; no `replace` directives; one
distinct pin remains across all 9.

| repo | from | build | test |
|---|---|---|---|
| Games-Labs-Provider | 20260731-0e429434 | ok | ok (17) |
| Games-Labs-Logs | 20260807-876e6983 | ok | ok (4) |
| Games-Labs-User | 20260807-876e6983 | ok | ok (7) |
| Games-Labs-Game | 20260811-7acc819b | ok | ok (8) |
| Games-Labs-Missions | 20260811-7acc819b | ok | ok (15) |
| Games-Labs-Order | 20260814-2ab2518f | ok | ok (7) |
| Games-Labs-Auth | 20260814-96b49170 | ok | ok (4) |
| Games-Labs-Wallet | 20260818-13f9f154 | ok | ok (10) |
| api-gateway | 20260818-13f9f154 | ok | ok (3) |

Not pushed. Awaiting operator approval to push branches and open PRs.

## Pushed + PRs opened (2026-08-21, operator-approved)
All nine branches pushed to origin; PRs opened against `staging`.
Every PR: base=staging, 2 files (go.mod, go.sum), MERGEABLE.

| repo | PR |
|---|---|
| Games-Labs-Auth | SparqLab/Games-Labs-Auth#9 |
| Games-Labs-Game | SparqLab/Games-Labs-Game#31 |
| Games-Labs-Logs | SparqLab/Games-Labs-Logs#13 |
| Games-Labs-Missions | SparqLab/Games-Labs-Missions#112 |
| Games-Labs-Order | SparqLab/Games-Labs-Order#42 |
| Games-Labs-Provider | SparqLab/Games-Labs-Provider#34 |
| Games-Labs-User | SparqLab/Games-Labs-User#18 |
| Games-Labs-Wallet | SparqLab/Games-Labs-Wallet#28 |
| api-gateway | SparqLab/api-gateway#52 |

**No PR-triggered CI exists in any of these repos** — no workflow declares a
`pull_request` trigger. `staging.yml` fires on `push: branches: [staging]`,
so merging each PR immediately triggers `Deploy STAGING` -> ECS. Local
`go build -mod=readonly` + `go test` is the only gate these changes get.

Recommended merge order: api-gateway last (it owns the wire format), Provider
first with a smoke pass after its deploy (20-day jump).

## Closed (2026-08-21)
All nine PRs merged by the operator between 11:41:34Z and 11:43:24Z, in the
recommended order (Provider first, api-gateway last).

Verified after merge:
- `go.mod` on remote `staging` in all nine repos reads
  `v0.0.0-20260820032904-861f0063a895` — one distinct pin, down from six.
- All nine `Deploy STAGING` runs completed `success` (~5-6 min each); run head
  SHAs match the merge commits.
- Local checkouts fast-forwarded back to `staging`; bump branches deleted
  locally; all trees clean.

Remaining: no staging smoke test was run against Provider (20-day jump) — its
deploy went green but runtime behaviour was not exercised. `prod` untouched.

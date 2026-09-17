# TASK-EAR-363 — Prod release train 2026-09-17

- Short name: `prod-train-2026-09-17`
- Type: release / devops
- Workstream: devops
- Priority: high
- Created: 2026-09-17
- Checklist: `docs/PROD-LAUNCH-CHECKLIST.md` → Gate 2 (refreshed 2026-09-17)

## Goal

Promote everything on `staging` that is not yet on `prod` across the eight
Games Labs services that have drifted since the TASK-EAR-322 / TASK-EAR-339
train, then supervise the boot on the new separate RabbitMQ broker.

## Scope (patch-unique staging commits, 2026-09-17)

| repo | commits | notable |
|---|---|---|
| Games-Labs-Order | 12 | redemption email UI (354/357/358/359), SMTP hardening, payment_gateway (352), Store Package facts (346), Wallet internal token |
| api-gateway | 9 | shared-lib pins: VIP turnover, reward claim (338), fast_pass (337), Store Player Log (346), payment_gateway (352), gameplay W/L (342) |
| Games-Labs-User | 9 | VIP turnover conversion (361), reward claim APIs (338, switch OFF), fast_pass (337), account-status publisher (356), non-active admin list |
| Games-Labs-Provider | 8 | staff-only provider mutations (275), AFB fail-closed (261), Postgres TLS (274), WIN_CAPTURE_PROVIDERS (192), VP launch log (305) |
| Games-Labs-Missions | 5 | Pass/Avatar store events + backfill job (346/351), event-plan daily scoring, Wallet internal token |
| Games-Labs-Auth | 4 | password + account-status email (355/356/360) |
| Games-Labs-Wallet | 3 | Stripe instrument capture (352), valuation rates (345), internal token Phase A |
| Games-Labs-Game | 3 | W/L outcome correction (342), VIP + THB stamps |
| Games-Labs-Logs | 0 | already current |

## Prepared

`release/TASK-EAR-363-prod` in all eight repos: `origin/prod` + `origin/staging`,
`go build -mod=readonly`, `go vet` and `go test ./...` all passing locally.
**Not pushed** — pushing from the Claude lane is denied by the permission
classifier; the operator pushes.

Two conflicts resolved by hand and must be reviewed:

1. **User `.github/workflows/prod.yml`** — union: prod's `GEMINI_*` and Cloud Map
   service addresses (TASK-EAR-271) plus staging's `VIP_REWARD_CLAIM_ENABLED`.
2. **Provider `config/config.go`** — prod's `url.URL` DSN (encoded credentials)
   combined with staging's `PostgresSSLMode()` (TASK-EAR-274). New test
   `TestPostgreSQLDSN_EncodesCredentialsAndKeepsSSLMode` fails against either
   one-sided resolution.

## Migrations

Auth 014, User 018, Order 043 + 044, Wallet 019. All idempotent under boot
replay; none pairs ADD with DROP COLUMN. Never roll them back.

## Hard order

1. Operator approval to run prod above desired 0.
2. Merge + Deploy PROD per repo (registers task definitions at desired 0).
   Verify all eight render the same new `RABBITMQ_URL` fingerprint, different
   from staging.
3. Scale one at a time to a completed deployment with a running task:
   Logs → Auth → User → Wallet → Order → Game → Provider → Missions.
   Confirm queues exist on the new broker.
4. api-gateway last. Then smoke `api-gateway.gameslabs.app`, including one
   `player.activity` that reaches Missions-prod and not Missions-staging.
5. Do not flip `VIP_REWARD_CLAIM_ENABLED`. Do not create DIAMOND catalog items.

## Known not-ready (does not block this train)

- Wallet payment secrets (11) and Provider integration secrets (31) are still
  missing: no payments and no game launches on prod until provisioned.
- `WALLET_INTERNAL_TOKEN` is not wired for prod: Wallet runs Phase A (log-only).
- Plaintext `SMTP_PASSWORD` in Auth/Order task env (TASK-EAR-349 blocked).
- api-gateway prod `USER_HTTP_URL` secret lacks the Cloud Map namespace.

## Rollback

Previous task-definition revision per service: Auth :24, User :15, Wallet :16,
Order :20, Game :21, Missions :18, Provider :16, Logs :12, api-gateway :16.
Broker rollback = restore previous `RABBITMQ_URL` and redeploy.

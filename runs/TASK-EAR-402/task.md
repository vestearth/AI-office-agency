# TASK-EAR-402 — Prod release train 2026-10-12 (supersedes TASK-EAR-363)

- Type: release / devops
- Workstream: devops
- Created: 2026-10-12 (operator decision: cut a fresh train instead of booting the 9/17 one)
- Checklist: `docs/PROD-LAUNCH-CHECKLIST.md` → Gate 2

## Why a new train

TASK-EAR-363's branches were merged into every `prod` branch on 2026-09-17 and
the task definitions registered, but prod never booted (all nine Games Labs prod
services desired 0 / running 0, checked 2026-10-12). Staging has moved on since
(Logs, api-gateway, Missions, Order, Game, Wallet, User, Provider), including
fixes from today (Logs header scan 7dd69b5, Game favorite lock 2eb5372). Booting
the 9/17 images would ship known-fixed defects, so the operator chose a fresh
train first.

## Prepared

`release/TASK-EAR-402-prod` = `origin/prod` + `origin/staging`, pushed per
drifted repo. **No PR is opened and nothing is merged into `prod`** — merge is
Deploy PROD and waits for the operator. Per-repo results: see
"Per-repo preparation" below.

## Hard order (carried from TASK-EAR-363, unchanged in substance)

1. Operator approval to run prod above desired 0 (cost-gated).
2. Merge + Deploy PROD per repo (registers task definitions at desired 0).
   Verify every brokered service renders the same `RABBITMQ_URL` fingerprint on
   `rabbitmq-prod` (84.247.150.206:5673), different from staging.
3. Scale one at a time to a completed deployment with a running task:
   Logs → Auth → User → Wallet → Order → Game → Provider → Missions.
   Confirm queues exist on `rabbitmq-prod`.
4. api-gateway last. Smoke `api-gateway.gameslabs.app`, including one
   `player.activity` that reaches Missions-prod and not Missions-staging. This
   is also TASK-EAR-309 acceptance criterion 2 (real cross-publish isolation).
5. Do not flip `VIP_REWARD_CLAIM_ENABLED`. Do not create DIAMOND catalog items.
   Do not set `WALLET_INTERNAL_TOKEN_ENFORCE=true` (TASK-EAR-368 owns that).

## Known not-ready (does not block the train)

- Wallet payment secrets and Provider integration secrets may still be missing
  on prod: no payments and no game launches until provisioned.
- Plaintext secrets in task-definition environment, including `RABBITMQ_URL`
  on all 16 brokered task definitions (TASK-EAR-369, needs an AWS operator).
- TASK-EAR-391 prod claim census needs prod running (or a prod DB read).
- api-gateway prod `USER_HTTP_URL` secret lacked the Cloud Map namespace as of
  9/17 — re-check before step 4.

## Rollback

Previous task-definition revision per service as of 2026-10-12: Auth :25,
User :17, Wallet :18, Order :22, Game :22, Missions :20, Provider :18,
Logs :12, api-gateway :19. Never roll back a migration; every new one must be
idempotent under boot replay.

## Per-repo preparation (2026-10-12)

Each `origin/release/TASK-EAR-402-prod` is exactly `merge --no-ff origin/staging`
into `origin/prod`: verified it contains both tips and no commit outside them.
No merge conflicted. `.github/workflows/prod.yml` and `ecs/` are unchanged
against `origin/prod` in every repo (Wallet changes `staging.yml` only).
No PR opened, nothing merged into `prod`, no workflow run, no AWS change.

| repo | release tip | patch-unique staging commits | build / vet / tests | new migrations |
|---|---|---|---|---|
| Games-Labs-Logs | `2d5f84f` | 23 | green, 132 tests, 0 skip | none (ClickHouse TTL expression only, existing table unchanged) |
| Games-Labs-Game | `ca4344c` | 5 | green, 180 tests, 0 skip | `033_game_favorites.sql` — idempotent |
| Games-Labs-Missions | `4a145fc` | 12 | green, 943 tests, 0 skip (drift fix TASK-EAR-403) | `056_weekly_claim_plan_attribution.sql` — idempotent, replay test passes |
| Games-Labs-Order | `795efbd` | 9 | green, 11 pkgs + 33 integration tests (compile fix TASK-EAR-403) | `045_add_gift_confirmation_email_claim.sql` — idempotent |
| Games-Labs-Wallet | `98bb20f` | 4 | green, 317 tests, 0 skip (isolation fix TASK-EAR-403) | `020_wallet_transactions_user_created_idx.sql` — see lock risk |
| Games-Labs-User | `2d3e9c8` | 1 | green, 8 pkgs, 0 skip | none |
| Games-Labs-Provider | `ff57a6c` | 1 | green, 245 tests, 0 skip | none |
| api-gateway | `e8ae838` | 14 | green, 56 tests, 0 skip | n/a |
| Games-Labs-Auth | — | 0 | no train needed | — |

### Decide before promoting

Items 1-3 were fixed on staging in TASK-EAR-403 (2026-10-12) and merged into the
Order, Wallet and Missions release branches; all three suites are green on the
release trees with every DB-gated test enabled. Items 4-5 remain.

1. **Missions `TestRepositorySQLResolvesAgainstFreshSchema` fails** with
   `relation "scores" does not exist` (`internal/repositories/mission_plan_players.go:131`).
   Already failing on `origin/staging` 06559a8 (introduced by f53dc44), so not
   caused by the merge. `scores` is a CTE built at runtime by `planPlayerCTE()`
   that the test's SQL scanner cannot follow; a throwaway test prepared all 10
   real statements against a migrated Postgres and `ListMissionPlanPlayers`
   ran. Accept as a known scanner false alarm for this train, or fix the
   scanner on staging first (own TASK).
2. **Order `tests/integration` does not compile** on prod or staging since
   TASK-EAR-352 (f5806e5): `purchase_test.go:141` calls `UpdatePaymentState`
   with too few arguments, so none of those tests (including
   `TestMigrationsReplayAddsNoDroppedColumns`) has run since. With that one
   line patched locally (never committed) all 33 passed on an empty database.
   Pre-existing; follow-up queued.
3. **Wallet `TestSumPlayerCoinLedgerPostgres` fails only when it shares a
   database** with the older lifetime top-up tests, which close their pool
   before cleanup and leave a table that trips migration 009. Alone on a fresh
   database it passes. Test-setup defect, not code; follow-up queued.
4. **Wallet migration 020** builds a plain (non-CONCURRENTLY) index on
   `wallet_transactions (user_id, created_at)` at first boot, blocking writes
   while it builds. Measure the prod table first; if large, create the index
   `CONCURRENTLY` by hand before the deploy so the migration is a no-op. Not
   checked (prod RDS is cost-gated).
5. **Order one-off command** `./main backfill-discount-split` (TASK-EAR-381)
   runs only with an ECS command override, never at boot. Running it on prod
   is a separate operator step.

### Flags confirmed safe

- `WALLET_INTERNAL_TOKEN_ENFORCE`: Wallet 1a9a73c sets `"true"` in
  `staging.yml` only; `prod.yml` still exports `"false"` (Phase A).
- `VIP_REWARD_CLAIM_ENABLED`: User `prod.yml` unchanged, defaults false.
- api-gateway `USER_HTTP_URL`: already hardcoded with the
  `games-labs-prod.local` namespace on `origin/prod`; the 9/17 gap is closed.
- api-gateway adds 9 routes and retires `POST /api/v1/webhooks/store-payment`
  (TASK-EAR-392). A 349-route overlap scan found only
  `/game/favorites` vs `/game/{id}`, resolved by registration order and
  covered by a test. The new routes answer 501 until their backends
  (Game, Missions, Logs, Wallet in this train) are serving — keep the hard
  order with api-gateway last.
- TASK-EAR-234 (api-gateway#90) is not on staging, so not in this train.

### shared-lib pins on the release tips (no `replace` anywhere)

Logs `a91d3a5`, Game `16b09af`, Missions `d4401c9`, Order `bf1fcf4`,
Wallet `f501126`, User `0d17deb`, Provider `bf1fcf4`, api-gateway `d4401c9`.
Provider proto packages are identical between `bf1fcf4` and `d4401c9`.

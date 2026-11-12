# TASK-EAR-402 — Prod release train 2026-10-12 (supersedes TASK-EAR-363)

- Type: release / devops
- Workstream: devops
- Created: 2026-10-12 (operator decision: cut a fresh train instead of booting the 9/17 one)
- Checklist: `docs/PROD-LAUNCH-CHECKLIST.md` → Gate 2

## Why a new train

TASK-EAR-363's branches were merged into every `prod` branch on 2026-09-17 and
the task definitions registered. Prod booted once, on 2026-09-30: every service
started at 04:09 UTC and shut down between 07:52 and 07:58 UTC (CloudWatch
`/ecs/<service>-prod`, evidence `ev-002`). Wallet applied migration 019 at that
boot. Nothing has run since. All nine Games Labs prod services were desired 0 /
running 0 when checked on 2026-10-12, and no prod log group has a line after
2026-10-01. (Corrected 2026-11-13. This paragraph used to say prod never
booted.) Staging has moved on since
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
| Games-Labs-Logs | `2ccfc02` | 24 | green, 134 tests, 0 skip | none (ClickHouse TTL expression only, existing table unchanged) |
| Games-Labs-Game | `104a2ef` | 6 | green, 181 tests, 0 skip | `033_game_favorites.sql` — idempotent |
| Games-Labs-Missions | `4a145fc` | 12 | green, 943 tests, 0 skip (drift fix TASK-EAR-403) | `056_weekly_claim_plan_attribution.sql` — idempotent, replay test passes |
| Games-Labs-Order | `059d148` | 10 | green, 373 tests + 36 integration (incl. subtests), 0 skip | `045_add_gift_confirmation_email_claim.sql` — idempotent; `046_coupon_usages_user_created_index.sql` — idempotent, see lock risk |
| Games-Labs-Wallet | `98bb20f` | 4 | green, 317 tests, 0 skip (isolation fix TASK-EAR-403) | `020_wallet_transactions_user_created_idx.sql` — see lock risk |
| Games-Labs-User | `2d3e9c8` | 1 | green, 8 pkgs, 0 skip | none |
| Games-Labs-Provider | `ff57a6c` | 1 | green, 245 tests, 0 skip | none |
| api-gateway | `ebb4f86` | 16 | green, 57 tests, 0 skip | n/a |
| Games-Labs-Auth | — | 0 | no train needed | — |

### Refresh 2026-10-14: TASK-EAR-389 and TASK-EAR-390 added (operator)

Logs, Game, Order and api-gateway release branches re-merged with
`origin/staging` (no conflicts; `prod.yml`/`ecs` still unchanged against
`origin/prod`; each tip is exactly prod + staging). Re-verified on the release
trees with every DB-gated test: Order 373 + 36 integration, Game 181, Logs 134
(ClickHouse 24.8 + Postgres), api-gateway 57 — 0 fail, 0 skip. Adds:

- Order: player coupon usage history (EAR-389) and **migration 046**, a plain
  `CREATE INDEX IF NOT EXISTS idx_coupon_usages_user_created` — measure
  `coupon_usages` on prod before the boot, like Wallet 020 (item 4).
- Logs: `ALTER TABLE monitoring_round_outcomes ADD COLUMN IF NOT EXISTS
  provider_id` at boot (metadata-only in ClickHouse) and the player providers
  read (EAR-390). Keep Logs before Game in the hard order: Logs accepts events
  with or without `provider_id`.
- Game: `provider_id` on round events (EAR-390). No currency is stamped.
- api-gateway: the two routes (coupon usages, player providers), served once
  Order/Logs are up — still last in the hard order.
- The backoffice tabs for both ship from the backoffice repo; it is not part
  of this Go train.

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

Logs `39fee4c`, Game `39fee4c`, Missions `d4401c9`, Order `6fb8a86`,
Wallet `f501126`, User `0d17deb`, Provider `bf1fcf4`, api-gateway `39fee4c`.
Provider proto packages are identical between `bf1fcf4` and `d4401c9`.

## Refresh needed (2026-11-13): release branches are behind staging

Checked 2026-11-13 by the Claude conductor (devops role). Evidence: `ev-001`
(gap listing plus an in-memory trial merge with `git merge-tree`; no ref
written) and `ev-002` (CloudWatch). The security detail is in
`security-gaps.local.md`. It is local only, because this repo is public.

The eight PRs are still open and mergeable. Each PR's head is the release tip
below. The release branches were cut on 2026-10-12/14, and `origin/staging`
has moved since then, to 2026-10-23 for Game and 2026-11-03 for the rest.
Staging now has **41 patch-unique commits** that no release branch has, and
some of them are authorization and money fixes. `origin/prod` has not moved,
and every release branch still contains it.

| repo | PR | release tip → staging tip | missing | security / money in the gap | build | new migrations | trial merge into release |
|---|---|---|---|---|---|---|---|
| Games-Labs-User | #44 | `2d3e9c8` → `7f29fab` | 2 | none (VIP level sent as POINT ledger metadata; amounts unchanged) | Docker fix | none | clean |
| Games-Labs-Wallet | #59 | `98bb20f` → `b6eb662` | 5 | **money** `ec69292` (reward idempotency race); **authz + money** `a548fce` (caller-scoped read, POINT ledger reason) | Docker fix | `021_wallet_points_ledger_user_created_idx.sql` | **conflict** `prod.yml` |
| Games-Labs-Order | #83 | `059d148` → `c244578` | 10 | **money** `5d6d897` (DIAMOND redemption ledger source); `9d4cdb8` + `a67e0b0` (activity outbox) | — | `047_add_user_redemption_carrier.sql`, `048_create_order_activity_outbox.sql` | **conflict** `prod.yml` |
| Games-Labs-Game | #49 | `104a2ef` → `ad824ca` | 2 | none (round currency) | — | `034_round_lifecycle_currency.sql` | clean |
| Games-Labs-Missions | #144 | `4a145fc` → `4139416` | 6 | **authz** `9ca01f4` (EAR-423), `5ea04d3` (EAR-422), `b2752b7` (EAR-420); **money** `0794b9d` + `a97f8a0` (EAR-408, paid-pass entitlement) | — | none | clean |
| Games-Labs-Provider | #42 | `ff57a6c` → `c3f00d2` | 6 | **new money path** BNG seamless wallet `86faecc`, `4b7dc54`, `8e6fd5a` (no PR, no review) | Docker fix | none | clean; adds 5 `BNG_*` to `prod.yml` and `ecs/env.names` |
| Games-Labs-Logs | #58 | `2ccfc02` → `3ef8fd0` | 1 | none | Docker fix | none | clean |
| api-gateway | #93 | `ebb4f86` → `f0f5baa` | 9 | **low** client-IP trust `d7d3086`, `f597261`, `52e162c` (EAR-234) | Docker fix | n/a | clean |

Per repo, newest first:

- User: `7b0ed2b` test, `31dd4da` EAR-420 feature + Docker fix.
- Wallet: `5210ce4` EAR-420, `a548fce` EAR-420, `ec69292` EAR-419,
  `560aeaa` EAR-419 Docker fix, `c53823a` EAR-419 (DEV-only reconciliation
  commands).
- Order: `2d204f9` + `ab1e3d4` EAR-420, `5d6d897` EAR-419, `a67e0b0` +
  `9d4cdb8` EAR-419, `db93108` + `3662bcb` EAR-418 (PR vet, test),
  `e409dfb` email copy, `b2927b0` + `36ec5b2` SPAR-40 (carrier).
- Game: `1e17014` + `81df9be` EAR-405.
- Missions: `9ca01f4` EAR-423, `68a6a42` EAR-420, `5ea04d3` EAR-422,
  `b2752b7` EAR-420, `a97f8a0` + `0794b9d` EAR-408.
- Provider: `5b65bed` EAR-421 Docker fix, `4b7dc54` + `8e6fd5a` +
  `86faecc` BNG, `3a4fc53` + `bbf1d2a` EAR-405.
- Logs: `6f11b9d` EAR-421 Docker fix.
- api-gateway: `954bffd` Docker fix, `003bd33` + `746bfb9` EAR-420 (Point
  Earned route), `003ced7` SPAR-40, `52e162c` + `f597261` + `d7d3086`
  EAR-234, `6b60cae` + `11f271e` (temporary probe and its revert; net zero).

**Build risk on the pre-refresh tips (corrected the same day).** User,
Wallet, Provider, Logs and api-gateway built with the token-only `insteadOf`
Dockerfile, which the staging Docker fixes replace. Their commit messages
record that api-gateway Deploy STAGING failed twice with git 2.54 in
`golang:1.25-alpine` on 2026-11-03. This first draft said Deploy PROD from
those tips was "expected to fail", but a control build did not reproduce it.
The control was the old api-gateway tip `ebb4f86`, built `--pull --no-cache`
for linux/arm64 on 2026-11-13. That image now ships git 2.54.1, and the token
was the operator's gh token, not the CI `GH_PAT`. The build passed. So the old
tips may or may not have failed in CI. The refresh removes the question.
Auth has no release branch, and its only staging-only commit is the same
Docker fix (`df02f26`). The prod Auth image `:25` needs no rebuild.

### Migrations that need the prod-size step (adds to "Decide before promoting" item 4)

- **Wallet 021** builds a plain `CREATE INDEX IF NOT EXISTS
  idx_wallet_points_ledger_user_created ON wallet_points_ledger (user_id,
  created_at DESC, id DESC)` inside the runner's transaction. That blocks writes
  to `wallet_points_ledger` while the index builds. Use the same procedure as
  020. Measure the prod table first. If it is large, build the index
  `CONCURRENTLY` by hand before the deploy, and 021 becomes a no-op. Wallet
  records each migration in `wallet_schema_migrations`, so 021 runs once. The
  prod schema is at 019 (applied 2026-09-30), so 020 and 021 run together at
  the next boot.
- **Order 047**: `ALTER TABLE user_redemption_items ADD COLUMN IF NOT EXISTS
  carrier TEXT NOT NULL DEFAULT ''`. **Game 034**: the same shape on
  `round_lifecycles`, plus a `COMMENT ON COLUMN`. Both are metadata-only on
  prod RDS `database-1`, which runs PostgreSQL 16.14 and is stopped (constant
  default, so no rewrite). Order and Game replay every migration
  on boot, so both take a brief ACCESS EXCLUSIVE lock on every boot, like the
  existing replayed ADD COLUMNs. No size gate is needed. Do confirm that
  nothing holds a long lock on those tables at deploy time.
- **Order 048** creates the new table `order_activity_outbox` and its two
  partial indexes. Nothing is touched on existing data. Idempotent.
- Order 046 and Wallet 020 checks stay as listed above.

### `prod.yml` after a refresh

Both options below hit the same two conflicts.

- **Wallet** `.github/workflows/prod.yml`: the release side has the
  Phase A token lines, and staging `ec69292` adds `export APP_ENV=production`.
  Resolve by keeping **both**: `WALLET_INTERNAL_TOKEN="${WALLET_INTERNAL_TOKEN:-}"`
  and `WALLET_INTERNAL_TOKEN_ENFORCE="false"` stay, and the `APP_ENV` line is
  added. `ecs/env.names` gains `APP_ENV` with no conflict. The DEV
  reconciliation commands fail closed unless `APP_ENV` is exactly
  `development`, so `production` keeps them off.
- **Order** `.github/workflows/prod.yml`: prod already fails on an empty
  `RABBITMQ_URL`. Staging `5d6d897` changes the old warning into the same
  error. Resolve by taking the staging side, which removes the dead duplicate
  `PORT`/`GRPC_PORT` and warning block. The fail-closed check stays, and
  staging's `cmd/deploy_config_test.go` checks it.
- **Provider**: there is no conflict, but 5 `BNG_*` secrets are added to
  `prod.yml` and `ecs/env.names`. While they stay unset in the production
  environment, BNG is inert on prod: `Seamless` returns 503 when the sign key is
  empty and `APP_ENV` is production, and `prod.yml` defaults `APP_ENV` to
  `production`. This was checked from code, not run.
- **Every other repo**: after the trial merge, `prod.yml` and `ecs/` are
  byte-identical to `origin/prod`.
- **Flags stay explicit.** `WALLET_INTERNAL_TOKEN_ENFORCE="false"` stays in
  Wallet `prod.yml` (TASK-EAR-368 owns the flip). User `prod.yml` keeps
  `VIP_REWARD_CLAIM_ENABLED="${VIP_REWARD_CLAIM_ENABLED:-false}"` from
  `vars`, and the variable is still listed in `ecs/env.names`. The refresh
  changes neither line.
- **Prod-only commits are kept.** Each option is a merge with `origin/prod` as
  an ancestor, so the 10–15 prod-only commits per repo stay. Those are the RDS
  secret injection, DSN URL-encoding, prod Cloud Map addresses and the
  `WALLET_INTERNAL_TOKEN` pass-through. Only the two conflict hunks above
  needed a hand resolution.

### Also on staging, not yet accepted (rides with a full refresh)

- TASK-EAR-405 is `in_review`: Game `81df9be` and `1e17014`, Provider
  `bbf1d2a` and `3a4fc53`.
- TASK-EAR-419 is `in_review`. App acceptance is in progress. It covers
  Wallet `c53823a`, `560aeaa` and `ec69292`, and Order `9d4cdb8`, `a67e0b0`
  and `5d6d897`.
- Provider BNG has no TASK run and no PR. TASK-EAR-425 (pending, opened
  2026-11-13) owns its internal-token and currency follow-ups.
- SPAR-40 (carrier) has no EAR run.
- TASK-EAR-234 is done and now on staging. The 10-14 line "not on staging, so
  not in this train" no longer holds.

### Proposed refresh (needs Earth's yes before any push)

| option | result | verdict |
|---|---|---|
| A. `git merge --no-ff origin/staging` into each `release/TASK-EAR-402-prod` | Tree = prod + current staging. Fast-forward push; the eight PRs update in place and keep their history. | **Recommended** |
| B. Re-cut from `origin/prod` + current staging | **The same tree as A** in all 8 repos (`git merge-tree`; the same two conflicts). Needs a force-push or new branches and new PRs. | No gain over A |
| C. Cherry-pick only the security, money and Docker fixes | Builds a combination that never ran on staging. Wallet `a548fce` needs shared-lib `d816962`, and Missions `b2752b7`/Wallet `a548fce` are a pair. Later staging merges get harder. | Fallback only |

Steps for A, per repo:

1. In an isolated worktree from `origin/release/TASK-EAR-402-prod`, run
   `git merge --no-ff origin/staging`. Resolve Wallet and Order `prod.yml`
   as described above.
2. Check:
   - the tip contains both `origin/prod` and `origin/staging`, and no
     non-merge commit sits outside them;
   - `git diff origin/prod -- .github/workflows/prod.yml ecs/` shows only:
     - Wallet: `APP_ENV`;
     - Order: the guard cleanup;
     - Provider: `BNG_*`;
     - every other repo: nothing.
3. Run `go build -mod=readonly ./...` and `go vet ./...` (Order also with
   `-tags integration`). Run the full tests with every DB-gated test enabled.
   Missions: confirm `TestRepositorySQLResolvesAgainstFreshSchema` still
   passes, since item 1 above is fixed. Wallet and Order: run the migration
   replay tests.
4. Build the image with `docker buildx build --secret id=GH_PAT` in the five
   Docker-fix repos. This proves the Deploy PROD build passes.
5. **Push only after Earth's yes.** It is a normal (fast-forward) push to
   `release/TASK-EAR-402-prod`, never to `prod`. Then re-pass
   `train_prepared` with the new tips and add the carried tasks.
6. Add a prod-size step for Wallet 021, next to 020 and Order 046.
7. Hard order and gates are unchanged. Merging any PR is still Deploy PROD and
   waits for Earth's cost approval.

Decisions for Earth:

1. Use A (recommended), or C?
2. Should EAR-405 and EAR-419 ride before their acceptance? They have run on
   staging since 2026-10-23 and 2026-10-30. Recommended: yes, because C would
   strand the money fixes that come with them.
3. Should BNG ride inert (secrets unset on prod), or be reverted on the release
   branch? Recommended: inert. A revert would have to be reverted again at the
   next refresh.
4. Is the push to the eight release branches approved?

`train_prepared` is still marked pass from 2026-10-12. Its claim, "containing
both current origin/prod and origin/staging", stopped being true when staging
moved. Treat the gate as stale until step 5.

## Refresh done (2026-11-13)

Earth approved option A in chat, with the recommended answers to decisions
1–4: full staging merge, EAR-405 and EAR-419 ride, BNG rides inert, and the
push was approved. The Claude conductor did the refresh (devops role). In each
repo, `git merge --no-ff origin/staging` ran in an isolated worktree on top of
the release tip. The result was pushed fast-forward to
`release/TASK-EAR-402-prod`. All eight PRs updated in place, still open and
mergeable. **Nothing was merged into `prod`.** No deploy workflow ran. The only
workflow triggered was Order's PR `vet.yml`.

| repo | PR | old tip → new tip | staging tip included |
|---|---|---|---|
| Games-Labs-User | #44 | `2d3e9c8` → `fbe7a7c` | `7f29fab` |
| Games-Labs-Wallet | #59 | `98bb20f` → `d2e9b8f` | `b6eb662` |
| Games-Labs-Order | #83 | `059d148` → `438d7ee` | `c244578` |
| Games-Labs-Game | #49 | `104a2ef` → `ad72ae3` | `ad824ca` |
| Games-Labs-Missions | #144 | `4a145fc` → `224246e` | `4139416` |
| Games-Labs-Provider | #42 | `ff57a6c` → `270b2ae` | `c3f00d2` |
| Games-Labs-Logs | #58 | `2ccfc02` → `a512909` | `3ef8fd0` |
| api-gateway | #93 | `ebb4f86` → `90a7875` | `f0f5baa` |

**Verified on the pushed tips** (`ev-003`, re-fetched after the push):

- Every tip contains `origin/prod` and `origin/staging`.
- No non-merge commit lies outside prod + staging.
- 0 staging patch-unique commits are missing.
- `prod.yml` and `ecs/` differ from `origin/prod` only by:
  - Wallet: `APP_ENV=production` plus `APP_ENV` in `env.names`;
  - Order: the dead `RABBITMQ_URL` warning block removed;
  - Provider: the 5 `BNG_*` names.
- `WALLET_INTERNAL_TOKEN_ENFORCE="false"` and
  `VIP_REWARD_CLAIM_ENABLED` (default false) are unchanged.
- Every `prod.yml` passes `GH_PAT` as a BuildKit secret, which matches the new
  Dockerfiles.

**Build, vet, tests** (raw logs in local
`evidence/refresh-20261113/testlogs/`; Postgres 16, ClickHouse 24.8 and
RabbitMQ 4.1 in throwaway containers; every DB-gated test enabled):

- `go build -mod=readonly ./...` and `go vet ./...` are clean in all eight.
  Order and Missions are also clean under `go vet -tags integration`.
- Top-level tests, all 0 fail and 0 skip:

  | repo | top-level tests |
  |---|---|
  | User | 109 |
  | Wallet | 284 |
  | Order | 277, plus integration 72 |
  | Game | 129 |
  | Missions | 609 |
  | Provider | 174 |
  | Logs | 130 |
  | api-gateway | 41 |

  Subtests come on top of these counts.
- The Missions replay integration test passes.
- The first Missions and Logs runs failed because of my test setup, not the code:
  - Missions pg tests expect an already-migrated DB, and Logs `admin_actions`
    tests need migration 003 applied.
  - Logs ClickHouse tests connect without a password.
  - On a second pass I reused DBs that two tests require to be empty.
  - Both suites passed in one clean run on fresh, correctly prepared databases.

**Image builds**: each tree built with `docker buildx build --pull --no-cache
--platform linux/arm64 --secret id=GH_PAT`, the same platform and secret
mechanism as Deploy PROD. All eight passed. Raw logs are in local
`evidence/refresh-20261113/buildlogs/`.

**Run bookkeeping:**

- `train_prepared` was re-passed with the new tips.
- `carries` gained TASK-EAR-234, 405, 408, 418, 419, 420, 421, 422 and 423,
  each checked with `git merge-base`. SPAR-40 and Provider BNG have no EAR run.

**Still open, unchanged:**

- the prod-run cost approval;
- the prod-size checks for Wallet 020 and 021 and Order 046;
- the hard order;
- `BNG_*` production secrets stay unset until TASK-EAR-425 and the BNG review
  items in `security-gaps.local.md` are closed.

If `origin/staging` moves again before the merge, refresh again first.

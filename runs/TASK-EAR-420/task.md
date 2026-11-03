> Current product rule (2026-11-03): **Item redemption uses POINT only**, confirmed by App with Christy and recorded in docs/GAMES_LABS_PROJECT_CONTEXT.md. This overrides older POINT/DIAMOND product requirements below. Do not request DIAMOND redemption features, App cases or Mobile handling. Existing code paths/fields are compatibility history, not a supported product target; data presence is unverified. Defensive positive-POINT filtering remains allowed. DIAMOND top-up/store/exchange are unaffected. Removing legacy code/contracts requires a separate task.

# TASK-EAR-420: Profile Settings History: Point Earned routing and reward display contract

## Status and authorization

- Type: bugfix + additive API contract enhancement.
- Priority: low / non-urgent (Mobile explicitly said this is not urgent).
- Workstream: Profile > Settings > History.
- Created: 2026-11-02 (Asia/Bangkok).
- Operator request: open the task, record the issues, and prepare an English reply; the operator may ask Cursor and Claude to review next.
- Current stage: pending PM/contract review. This intake does not authorize implementation, publishing shared-lib, deployment, database writes, historical backfill, or synthetic financial actions. Do not automatically dispatch reviewers or runners.

## Goal

Let Mobile build Purchase, Point > Used, and Point > Earned History with a documented public gateway contract. Reuse existing ledgers/services where appropriate; repair the earned-history route and supply the display information missing from the current record contract.

## Mobile request

Mobile proposes `GET /api/v1/store/history?userId={userId}` for Package/Special Pass purchases and `GET /api/v1/my-redemption-items` for points spent on redemptions. For Point > Earned, they ask whether to reuse an endpoint or add one. They report HTTP 200 with a single object in `data` from `GET /api/v1/wallet/point-history` on DEV. Each earned record needs:

1. Points earned.
2. Transaction time.
3. Reward title, e.g. `Daily Login (D3)`.
4. Category, e.g. `Quest`.

UI examples also include `Turn Over (30,000 Coins)` / `Play Game` and `Up To (VIP 3)` / `Level up`. These are UI requirements/examples, not proof that each reward currently pays POINT or that exact category vocabulary has been approved.

## Findings and evidence boundary

Verified from local checkouts and the gateway's pinned shared-lib dependency, 2026-11-02; not verified against the actual DEV deployment:

1. **Wrong route / wallet lookup collision.** `shared-lib/proto/walletpb/wallet.proto:35` declares `GET /api/v1/wallet/{user_id}`. `ListPointHistory` at line 122 declares `GET /wallets/point-history`, not the URL Mobile called. A temporary local grpc-gateway probe using api-gateway's pinned shared-lib reproduced `/api/v1/wallet/point-history?userId=test-user` dispatching `GetWalletByUserID` with path user ID `point-history`, returning an object-shaped `data`. The same probe dispatched `/wallets/point-history?userId=test-user` to `ListPointHistory`, returning array-shaped `data`. This used a stub, not a real account/DEV request; the actual wallet handler may return different status/data for the path value. Inspect `Games-Labs-Wallet/internal/core/handlers/wallethdl/grpc.go:206` before making a runtime claim.
2. **History binding is outside the public mount.** `api-gateway/gateway/http.go` mounts the grpc-gateway mux only through `/api/v1/*`. Calling the current `/wallets/point-history` binding is therefore not a confirmed usable public workaround. Do not tell Mobile simply to switch to it.
3. **Response gap.** `walletpb.PointHistoryItem` at `shared-lib/proto/walletpb/wallet.proto:383` contains `points_delta`, `created_at`, `reason`, and `metadata_json`, but no explicit reward title/category. The mapper is `Games-Labs-Wallet/internal/core/handlers/wallethdl/grpc.go:552`. The response already declares `repeated PointHistoryItem data`; changing an object to an array alone does not fix the wrong-route call.
4. **Earned filtering is missing on the public RPC.** `ListPointHistoryRequest` has user ID, limit, and offset only. `Games-Labs-Wallet/internal/repositories/wallet.go:1329` lists the user's entire POINT ledger, ordered by created time. Existing reason bucket definitions in `internal/repositories/wallet_history_reasons.go` are a discovery lead, not an approved Mobile category mapping; comments there include historical assumptions that need current-source verification. Refunds/compensation must not be treated as earned rewards merely because the delta is positive.
5. **Display metadata is not guaranteed.** `Games-Labs-Wallet/internal/repositories/wallet.go:1086` (`CreditPoints`) inserts point history with nil metadata. Reason alone cannot reliably reconstruct dynamic details such as D3, VIP 3, or the earned-time mission title. Trace each supported reward producer before choosing enrichment or metadata persistence. Some mission rewards pay COIN/DIAMOND; do not relabel these as POINT or change reward amounts/currencies.
6. **Purchase reuse has code support.** `Games-Labs-Missions/internal/handlers/mission/http/store.go:312` returns a `history` collection via `GetHistory`; public `StoreHistory` uses a protobuf Struct through `internal/handlers/mission/grpc/server.go:358`. `finishStorePurchase` in `internal/repositories/store_repo.go:544` persists completed Pass purchases in purchase_history; package recording is in `internal/services/store_service.go:1533`. Confirm representative package/pass rows in DEV before declaring end-to-end coverage. These Struct payload keys are not automatically camelCase-normalized.
7. **Used reuse needs currency handling.** `ListMyRedemptionItems` (`Games-Labs-Order/internal/core/handlers/orderhdl/grpc.go:574`) returns `items` + `page` scoped to the authenticated caller. `UserRedemptionItem` carries pointSpent, redeemedAt, itemName, priceCurrency, and priceAmount. The code can represent non-POINT rows; their existence in live data has not been checked. Item redemption is POINT-only; defensively keep any non-POINT rows out of Point > Used. Define handling of legacy empty currency as POINT and zero-cost/admin-granted rows. Do not confuse a point-spend record with voucher-consumption status.

Local source provenance:

- api-gateway: `83ccbe184e24ad33d72663b1c2d7473d71ad57d8`; pinned shared-lib `v0.0.0-20261023041614-5498b9aae154`.
- Games-Labs-Wallet: `8b73a5a06aab420a7024da5ba76c599ef2e3ae1e`.
- Games-Labs-Missions: `6d5500cebc2a6ee6670e89098201e2dd01098171`.
- Games-Labs-Order: `e409dfb16b9d352c0d73855bd5b03827f698e448`.
- shared-lib checkout: `1bd040a6cd089640e8c01aeae7d79855d2291597` (the gateway dependency pin, not this checkout alone, decides its compiled routes).
- Earlier focused check passed: `GOWORK=off go test -mod=readonly ./internal/core/services/walletsvc -run '^TestListPointHistory$' -count=1`. This proves only the existing service list/pagination test, not the missing Mobile contract, routing fix, title/category, or DEV behavior.

## Proposed scope for review

- Primary owners: `shared-lib` (proto/binding contract), `Games-Labs-Wallet` (history read/mapping and required metadata flow), and `api-gateway` (public routing and compiled dependency).
- `Games-Labs-Missions` and `Games-Labs-User`: trace reward origins and include only the minimal producer changes proven necessary for POINT display metadata; settle precise file scope before implementation.
- `Games-Labs-Order`: read-only verification of Point > Used reuse. Any required Order change needs a concrete review finding and explicit scope update.
- Prefer a public binding on the existing ListPointHistory RPC and additive fields/filters. The exact URL/response contract remains a review decision; avoid building another ledger or a general aggregation service without evidence.
- Bind Mobile history to trusted authenticated identity; do not expose another user's history via a query parameter. Review both the request and the service handler when adding the public route.
- Keep existing clients/fields compatible, including numeric JSON conventions (protobuf int64 values are strings) and empty-list shape.

## Questions for Cursor / Claude review

1. Reproduce the dynamic route collision using the gateway's actual shared-lib pin and registration/mount behavior. Does current DEV run the same revisions/routes? Request a redacted raw response and exact base URL if needed; HTTP 200 alone is insufficient.
2. Is an additive public binding plus fields on the existing RPC sufficient? Decide the public path, JSON names, points sign/type, timestamp timezone, pagination, and supported Earned filters/category vocabulary.
3. Which actual POINT producers cover the UI examples? Where should title/category/source references be captured? How should old records with missing metadata display without fabricated historical titles?
4. Should Earned display all positive reward credits, or only selected reasons? Explicitly decide refunds, adjustments, reversals, passive turnover, and unknown legacy reasons; distinguish stable category code from display label/localization if needed.
5. How should Point > Used exclude DIAMOND and free grants, and how should legacy POINT records be interpreted? Is existing pagination sufficient without backend changes?
6. Does TASK-EAR-419's in-review Wallet/Order work affect the implementation baseline? Re-check branches/PRs and DEV images; do not overwrite those changes or assume local staging equals DEV.

## Acceptance criteria

- [ ] Review approves final ownership, public URL, record schema, category mapping, and legacy display policy; unresolved product choices remain explicit.
- [ ] A regression test is observed failing before the route fix; through the real gateway configuration the intended earned-history URL invokes ListPointHistory, never GetWalletByUserID. Existing wallet-balance URLs retain their behavior.
- [ ] Every earned record provides earned points, transaction time, reward title, and category with documented semantics. Dynamic titles preserve source context; missing historical context uses an explicit approved fallback.
- [ ] Earned filtering/pagination operate on the intended ledger set; spent rows and refund/compensation credits are handled according to the approved rule, with stable ordering across pages.
- [ ] Cross-user history access and unauthenticated access fail; query-supplied user IDs cannot override the logged-in user's identity.
- [ ] Existing Purchase and Used contracts remain compatible; DEV examples prove Package, Special Pass, and POINT redemption coverage, with DIAMOND correctly separated.
- [ ] Empty/one/multiple records, pagination boundaries, unknown reasons, and legacy missing metadata are verified through the gateway JSON contract; amount string handling and timestamp format are documented for Mobile.
- [ ] Focused regression/contract tests and appropriate readonly build/lint checks pass on the reviewed revisions.
- [ ] After separately authorized DEV deployment, record exact service/gateway revisions and redacted real gateway requests/responses; distinguish deployed, runtime-verified, and App-accepted status. No synthetic purchase/redemption or reward claim without explicit authorization.
- [ ] Deliver final API examples and mapping notes to the operator for Mobile handoff.

## Delivery constraints and dependencies

- shared-lib contract/proto first; regenerate rather than hand-edit generated files. If new shared types are required, stop for the operator to publish/bump shared-lib before downstream implementation.
- PR targets: shared-lib -> main; Wallet, Missions, User, and api-gateway -> staging. Inspect each deploy workflow before publishing; no PRs or deployment are authorized by this task opening alone.
- If schema/index changes prove necessary, include a new migration plus deploy order/rollback; Missions migrations must be replay-safe. No migration is assumed necessary at intake.
- Do not edit/build Games-Lab-Android. Do not change balances, reward rules, real env files, payment/redeem behavior, or production runtime. Never fabricate historical reward details.

## English reply draft (operator to send)

Thanks for the details. For Purchase history, we can reuse `GET /api/v1/store/history` for Package and Special Pass records. For Point > Used, we can reuse `GET /api/v1/my-redemption-items`, for POINT spends only, with free grants excluded.

For Point > Earned, we can build on the existing point ledger. In our local check, `/api/v1/wallet/point-history` currently matches the wallet lookup route, which explains the object-shaped response in that check. We still need to verify the response on DEV.

I have opened TASK-EAR-420 to address the public history route and define the record response with points earned, transaction time, reward title (such as “Daily Login (D3)”), and category (such as “Quest”), together with pagination.

We will share the confirmed endpoint and sample responses after review and DEV verification. The exact route and response contract are still under review.

## Codex answers to Cursor (2026-11-02)

See [cursor-review-response.md](cursor-review-response.md) for answers to all six questions, source evidence, and current DEV image/PR checks (TASK-EAR-420 ev-002 through ev-004). This follow-up preserves Cursor's contract-review.md and gate history.

Planning scope is refined from the initial intake: a dedicated Mobile earned RPC is preferred; Order's additive positive-POINT currency filter and Missions StoreHistory caller scoping are now concrete review recommendations, rather than Order remaining read-only at implementation time. Source code is still unchanged and implementation/deployment are not authorized by this documentation follow-up.

Two caveats must remain explicit: the allowlist does not cover all historical malformed mission reasons, and a numeric turnover title needs a defined stored amount/rate meaning. A plain staging deploy must not drop the TASK-EAR-419 Wallet/Order code currently running on DEV.

## Operator decisions (2026-11-03)

- **Turnover title: generic.** `point_turnover` rows use the fixed title `Turnover Reward`, category `play_game`, for both new and legacy rows. This supersedes the `Turn Over ({pointsEarned * 5000} Coins)` row in contract-review.md. Reason: `calculatePointTurnoverProgress` (`Games-Labs-Wallet/internal/repositories/wallet.go:1211`) pools carried-over turnover, so `pointsEarned * CoinsPerPoint` is not the triggering transaction's amount. No turnover amount/rate snapshot needs to be persisted in ledger metadata for the title; do not change reward math or balances.
- **Deploy baseline: wait for TASK-EAR-419 to merge.** No TASK-EAR-420 Wallet or Order build is deployed to DEV/staging until Wallet #60 (`ec69292`) and Order #87 (`5d6d897`) are merged into `staging`; 420 Wallet/Order branches are then cut from or rebased onto that merged staging. As of 2026-11-03 both PRs are OPEN draft. shared-lib, Missions, User, and api-gateway preparation is not blocked by this, but nothing here authorizes implementation or deployment.
- **Mobile reply sent by the operator** (reported 2026-11-03; wording close to the intake draft above): Purchase reuses `GET /api/v1/store/history`; Used reuses `GET /api/v1/my-redemption-items` "filtering for POINT redemptions"; `/api/v1/wallet/point-history` matches the wallet lookup route (DEV unverified); a backend task will provide points, time, reward title, category, and pagination; final endpoint and samples after review and DEV verification. Not yet told to Mobile: the new path `/api/v1/wallet/points/history`, do not send `userId`, POINT filtering is server-side `currency=POINT` (not a client filter), legacy rows are excluded or have an empty title, and turnover rows show `Turnover Reward`.
- **Mobile follow-up held** (2026-11-03): the clarification (no `userId`, server-side `currency=POINT`, path `/api/v1/wallet/points/history`, category codes, empty-title/legacy-exclusion policy, `Turnover Reward`) waits for product to confirm the legacy Earned coverage policy. Send it as one message after that confirmation.

- **StoreHistory with another user's `userId` returns 403 (operator, 2026-11-03).** It follows the repo convention (`resolveOwner`): no `userId` → the caller's own history; the caller's own id → allowed; another user's id → `PermissionDenied` (gateway 403); no identity → 401. This supersedes contract-review.md's "ignore a mismatched userId" for Purchase. The held Mobile follow-up must say: do not send `userId`; if sent, it must be the logged-in user's, otherwise the response is 403.
## Parallel preparation packet — 2026-11-03

The operator requested preparing 420 in parallel while 419 acceptance is pending. See [api-contract-draft.md](api-contract-draft.md) for proposed proto additions, JSON examples, field semantics, metadata ownership, and the RED/GREEN regression matrix. This supersedes no implementation/release gate; downstream execution and deployment remain in the documented order.
- **Product rule: item redemption is POINT-only** (App team, 2026-11-03, after confirming with Christy; recorded in `docs/GAMES_LABS_PROJECT_CONTEXT.md` → Product rules). For Point > Used, keep the server-side `currency=POINT` filter. It still excludes zero-cost/admin grants and any leftover DIAMOND rows, and whether such rows exist has not been checked. In the held Mobile follow-up, describe it as "POINT spends only, free grants excluded", not as separating DIAMOND redemptions.

## Verified upstream staging integration — 2026-11-03

419 candidate code is merged and deployed: Wallet60 -> staging688fd855fbfd26a548c90a12a71daf529f231d5a / revision82; Order87 -> staginga5367df010dc31ef1db33bee6f0ca8f876bd6cb7 / revision107. Workflow success, unchanged application trees, expected runtime digests, health and immediate pre-merge config hashes verified in TASK-EAR-419 ev-141–153. See ../TASK-EAR-419/merge-staging-20261103.md. This resolves the unmerged-baseline prerequisite; historical recovery remains separately pending. Re-fetch latest staging before 420 branches. Contract review/preparation is available; shared-lib publish/bump still precedes downstream implementation. No 420 implementation/deploy is claimed by this update.

## Product rule propagation follow-up — 2026-11-03

Aligned api-contract-draft.md, implementation-sequence.md, contract-review.md and cursor-review-response.md with the shared POINT-only item redemption rule. Current Mobile wording: "Point > Used shows POINT spends only; free grants are excluded." Keep currency=POINT as a defensive server-side query filter, with filtered counts/pagination. No evidence establishes whether unexpected non-POINT stored rows exist. Do not offer DIAMOND item redemption or request its App acceptance.

Source inspection confirms legacy Order ResolveRedemptionPrice and DIAMOND debit/refund branches still exist; product policy is not yet API-level enforcement. 420 remains a history/read contract task. Removing those branches, removing fields, or enforcing POINT-only writes across admin/catalog/redemption paths requires separately scoped work, as the shared context states. No runtime code, catalog data, currencies outside item redemption, or migration was changed by this follow-up.
- **TASK-EAR-419 baseline landed** (checked 2026-11-03 ~11:10 Bangkok): Wallet #60 merged to `staging` as `688fd85` and Order #87 as `a5367df` (both 2026-11-03). Both merge trees are identical to the accepted heads `ec69292` / `5d6d897`. Deploy STAGING succeeded for both. ECS `sparqlab-development-ecs` runs wallet td 82 `staging-sha-688fd85` and order td 107 `staging-sha-a5367df`, 1/1 COMPLETED. The deploy-baseline wait above is satisfied: cut 420 Wallet/Order branches from current `origin/staging`. Implementation is still not authorized by this note.

## Implementation: shared-lib (2026-11-03)

The operator authorized implementation, starting with shared-lib. PR: https://github.com/SparqLab/shared-lib/pull/98 (branch `task/TASK-EAR-420-earned-history`, commit `a091b65`, base `main` `1bd040a`).

- `WalletService.ListMyEarnedPointHistory` at `GET /api/v1/wallet/points/history`. Request: `limit`/`offset` only, no `user_id`. Response: `data: EarnedPointHistoryItem[]` (`id`, `points_earned`, `earned_at`, `reason`, `category`, `title`) and `page: basepb.Pagination`. `ListPointHistory` is unchanged.
- `ListMyRedemptionItemsRequest.currency` (field 6). `POINT` returns only resolved positive POINT spends. Empty means every currency, as today.
- **RED, seen before the proto change:** the new route returned 404 through the generated mux, the RPC was missing, and the `currency` field was missing.
- **GREEN:** `go build ./...`, `go vet`, and `go test ./... -count=1` all pass. `buf breaking` against `origin/main` is clean. `buf lint` gives an identical finding set on `origin/main` and HEAD (the reviewer counted 652 output lines; my earlier 642 dropped stderr), so nothing new.
- **Excluded:** unrelated admin swagger drift already on `main`. VIP level from User goes over Wallet HTTP `/wallets/credit-points`, so it needs no shared-lib change.
- **Next:** review and merge #98, then the operator publishes it. After that, bump the pin in Wallet, Order, and api-gateway. Nothing is deployed.
- **Review (Claude reviewer lane, 2026-11-03): approve with nits.** No blocking findings. The reviewer checked the following independently:
  - All 22 services were registered in the gateway's order. The new path reaches the earned RPC, while `/api/v1/wallet/user-1` and `/api/v1/wallet/point-history` still reach `GetWalletByUserID`.
  - Query `userId` and `user_id` are dropped.
  - `buf breaking` is clean.
  - `make buf` reproduces the generated files byte for byte. The admin swagger drift already exists on `main`.
  - Mutation checks: the tests fail when the binding is removed, when `user_id` is added, and when `currency` is removed or renamed.
  - The `currency` case rule was clarified as trim plus upper-case, the same as `ResolveRedemptionPrice` (commit `9480f77`, pushed).
  - Carried to the service PRs:
    - The Order PR needs an A/B caller test, because `ListMyRedemptionItemsRequest.user_id` already binds from the query.
    - The api-gateway pin bump needs a route test built on the full mux. A trailing slash returns 404.
  - Review summary posted on PR #98 (comment 6595561870). The parallel `api-contract-draft.md` packet matches this proto field for field.
- **Merged (2026-11-03 11:39 Bangkok):** shared-lib #98 was merged into `main` as `d816962ad66bd43e2194fc6d3495c7592a0ccad6` (head `9480f77`, merge state CLEAN, no PR CI on this repo). The Go module resolves as `github.com/SparqLab/shared-lib v0.0.0-20261103043938-d816962ad66b`. Next step: bump that pin in Wallet, Order and api-gateway on branches cut from current `origin/staging`. Nothing is deployed.

## Implementation: Wallet (2026-11-03)

PR: https://github.com/SparqLab/Games-Labs-Wallet/pull/61. Branch `task/TASK-EAR-420-earned-history`, commit `a548fce`, base `staging` `688fd85` (includes 419). The shared-lib pin was bumped to `v0.0.0-20261103043938-d816962ad66b`. Build, vet and the test baseline were green after the bump.

**Read path: `ListMyEarnedPointHistory`**
- The subject comes only from `resolveCallerID`. A call without identity fails closed with MetaDataNotFound, and there is no staff override.
- The allowlist is 15 reasons. Each maps to a category: quest, play_game, level_up or topup.
- Titles are built only from metadata stored on the row: `day`, `level`, `activity_name`. Daily Streak, Top Up Bonus and Turnover Reward are fixed titles. A legacy row without that metadata gets an empty title.
- Ordering is `created_at DESC, id DESC`. Limit defaults to 20 with a maximum of 100; offset is floored at 0.
- The total comes from a separate COUNT query, so it is still correct on a page past the end. `totalPage` = ceil(total / limit).

**Write path**
- The POINT ledger reason is `metadata.reason`, falling back to source, then `credit_points`. This fixes mission POINT rows being stored under a date or an id.
- `CreditPoints` now persists metadata.
- `/wallets/credit` POINT requests keep `reference_id`, `day` and `activity_name` in metadata.
- `/wallets/credit-points` keeps `level`.
- COIN and DIAMOND credits are unchanged.

**Migration 021:** `idx_wallet_points_ledger_user_created (user_id, created_at DESC, id DESC)`. The ledger previously had no `user_id` index.

**RED** (`evidence/wallet-red-20261103.log`, local), seen on a signature-only scaffold:
- `ledger reason = "2026-11-03", want the semantic check_in_day`
- Missing identity answered 200.
- The service was never called with the caller.
- The index was missing.
- Metadata was dropped in both the handler and the repo.

**GREEN** (`evidence/wallet-green-20261103.log`):
- `go vet ./...` passes.
- `go test ./... -count=1` passes with `WALLET_REPO_TEST_DSN` set, against a throwaway `postgres:16-alpine` container.
- `TestRepositorySQLResolvesAgainstFreshSchema` passes on an empty database.
- `-race` passes on `internal/core/...`.

**Open:**
- The size of `wallet_points_ledger` on DEV has not been measured. 021 runs inside a transaction. If the table is large, build the index by hand with `CONCURRENTLY` before deploying.
- Deploy order: Wallet goes before the api-gateway pin bump; otherwise the route returns 501.
- The PR has not been independently reviewed yet.
- **Wallet review (Claude reviewer lane, 2026-11-03): approve with nits.** No blocking findings.
  - Verified:
    - Caller-only identity.
    - Every POINT caller across the workspace was traced.
    - No effect on idempotency/replay, payment reconciliation, EXP, turnover or 419.
    - COIN/DIAMOND unchanged.
    - 14 mutations, all caught.
  - Fixed in `5210ce4`:
    - S1, the tie-break: it was sorting on `id::text` and added an Incremental Sort. Now qualified. I re-checked with EXPLAIN on 200k rows; the plan is now a plain Index Scan.
    - S3: allowlist parity test against `EarnedReasons`.
    - S5: PR description corrected.
  - Full suite re-run green with Postgres and fresh-DB drift (`-p 1`). Review summary is PR comment 6595925694.
  - **Open:**
    - **W1:** count `wallet_points_ledger` rows on DEV/prod before deploy. 021 holds a SHARE lock during the build, which blocks POINT inserts including `point_turnover` inside coin debits.
    - **S2:** Missions/User must send `day`/`level` as whole JSON numbers.
    - **S4:** the BO Player Detail Earned tab will start showing new mission POINT rows.
- **W1 count attempt (2026-11-03):** I tried to read the DEV `wallet_points_ledger` size and could not.
  - The Wallet staging container (`43ffbca8…`, ECS Exec enabled) has no `psql`.
  - An SSM port-forward through that task was denied for IAM user `vestearth`: no `ssm:StartSession`.
  - I did not launch a throwaway task.
  - The size stays **unmeasured**. The operator can run the read-only query in the reply below, in DBeaver.
  - Context, not a measurement: migration 020's comment records staging `wallet_transactions` at about 7.5k rows / 2.7 MB.
- **Operator DBeaver result (2026-11-03), connection `aws-ez2-postgres`:** `wallet_points_ledger` has two indexes, `wallet_points_ledger_pkey` and `ux_wallet_points_ledger_idempotency_key`. There is no `user_id` index, which confirms that 021 is needed. It is not yet confirmed whether this connection is DEV (`gamelabs`). The size query (`reltuples` / `pg_relation_size`) has not been returned yet.
- **W1 measured on DEV (2026-11-03, operator DBeaver, `aws-ez2-postgres` = `gamelabs` @ `10.80.134.150`, the same host as the Wallet staging task definition):**
  - `wallet_points_ledger` has `reltuples` ≈ 2,258 rows. Table 672 kB, total 904 kB. Latest row 2026-11-03 10:08:24 +07.
  - At this size, building 021 at boot inside the migration transaction is effectively instant. No manual `CONCURRENTLY` pre-build is needed for DEV/staging.
  - **Prod is not measured** (connection `Prod-Gamelab`; prod is cost-gated at desired 0). Measure it again before any prod promotion.
- **Wallet merged and deployed to DEV (2026-11-03):**
  - PR #61 merged at 12:36 Bangkok as `b6eb662eb7e234c4558107ab8d1967aafdfd6d6b` (head `5210ce4`).
  - Deploy STAGING run 41584929547 succeeded. Job `build-push` and job `deploy-ecs` both succeeded.
  - ECS `games-labs-wallet-staging` is on task definition 83, image `staging-sha-b6eb662`, desired/running 1/1, rollout COMPLETED.
  - Boot log for new task `b4820fb2…` at 05:39:02Z: PostgreSQL connected → `Migration applied: 021_wallet_points_ledger_user_created_idx.sql` → HTTP :8084 and gRPC :50054 started → RabbitMQ consumer started. Migration and listener appear in the same second.
  - The shutdown at 05:39:32Z belongs to old task `43ffbca8…`.
  - CloudWatch error/panic/fatal lines since 05:38:30Z: 0.
  - **Not yet verified:** the earned endpoint through the public gateway (the api-gateway pin is not bumped), and new POINT rows being written with semantic reasons (needs a real reward claim; no synthetic claim was made).

## Implementation: api-gateway (2026-11-03)

PR: https://github.com/SparqLab/api-gateway/pull/98. Branch `task/TASK-EAR-420-earned-history`, base `staging` `83ccbe1`.

**Pin bump:** shared-lib `5498b9aae154` → `d816962ad66b`. A proto diff over that range shows exactly one new HTTP binding, `GET /api/v1/wallet/points/history`. The other changes are additive fields: Order `currency` and a gamepb `SettleRound` field.

**Route test:** `gateway/wallet_earned_history_routes_test.go`. It builds the gateway through the real `NewGRPCServer` (all services, boot order, `FromEndpoint`, real mux options) against a recording gRPC backend, and checks:
- The new path reaches `ListMyEarnedPointHistory`.
- `X-User-ID` is forwarded as `userid`, and query `userId` / `user_id` are ignored.
- Empty `data` is `[]`.
- `/api/v1/wallet/user-1` and `/api/v1/wallet/point-history` still reach `GetWalletByUserID`.
- A trailing slash returns 404.

**RED** on the old pin: `GET /api/v1/wallet/points/history = 404`.

**GREEN:** `go build`, `go vet` and `go test ./... -count=1` all pass.

**Middleware:** the `/api` chain in `http.go` is unchanged — `Auth` (the path is not on the skip list), `RequireAdminAPIAccess`, `InjectTrustedIdentityHeaders`.

**Not done yet:** review, merge, DEV deploy, and a real authenticated request through the DEV edge.
- **Gateway review (Claude reviewer lane, 2026-11-03): approve with nits.** No blocking findings.
  - Verified:
    - Full Go diff of the pin range: none of the gateway-imported packages changed, and the only new pattern is the earned path.
    - Module cache equals `git archive d816962`, and `go mod tidy -diff` is clean.
    - Edge security by code reading: Auth applies to the path, identity headers are stripped and re-injected, and `RequireAdminAPIAccess` treats it as a player route.
    - 3 mutations, all caught. 50/50 runs pass under `-race`.
  - Fixed in `003bd33`: S2, the test now rebuilds package config after it runs. Re-ran the suite, 20× `-race`, and `-shuffle`; all green.
  - Noted only:
    - S1: the Gin chain is not exercised in the test.
    - S3: the backend decodes every request as `Empty`.
    - S4: the Order `currency` filter is not live yet, so do not promise it to Mobile.
  - Status gates: `implementation_verification`, `deploy_staging`, `independent_review` and `staging_acceptance` cover the whole task (Order/Missions/User are still open), so they stay pending. Per-service evidence is recorded here.
- **Gateway merged; the DEV deploy failed (2026-11-03).**
  - PR #98 merged at 13:19 Bangkok as `8706b68f509d6314b10933ac2a7b09aaded282e5` (head `003bd33`).
  - Deploy STAGING run 41589131713: job `build-push` failed and `deploy-ecs` was skipped.
  - Cause, in the Docker `go mod download` step: `github.com/SparqLab/shared-lib@v0.0.0-20261103043938-d816962ad66b: invalid version: git ls-remote ... fatal: could not read Username for 'https://github.com': terminal prompts disabled`.
  - This is a credentials failure, not a code failure. The repo secret `GH_PAT` in api-gateway was last updated 2026-03-11. Wallet's own `GH_PAT` (updated 2026-03-10) fetched the same shared-lib version successfully 40 minutes earlier, which points to the api-gateway token being expired or revoked, or lacking access to shared-lib. The token itself was not inspected.
  - The last successful gateway build was 2026-10-23 (`83ccbe1`).
  - DEV is unaffected and still runs td 138 `staging-sha-83ccbe1` (1/1, COMPLETED). The `staging` branch is now ahead of the deployed gateway.
  - **Needs the operator:** rotate the `GH_PAT` secret on SparqLab/api-gateway, then re-run the deploy.
- **Gateway deploy root cause corrected (2026-11-03): the token was not the cause.**
  - The operator rotated `GH_PAT` (updated 06:23:54Z) and says the token has no expiry. Re-run attempt 2 failed with the identical error.
  - Reproduced in `golang:1.25-alpine` (git 2.54): `url."https://TOKEN@github.com/".insteadOf` produces `could not read Username` for an empty, a bogus, or a valid token. git drops token-only userinfo on GitHub's redirect.
  - `x-access-token:TOKEN@` and `.netrc` both send credentials.
  - Local `docker buildx build --secret id=GH_PAT` with a real token: the old Dockerfile fails with the CI error; the new `.netrc` Dockerfile builds the full image.
  - Fix: https://github.com/SparqLab/api-gateway/pull/99 (`fix/TASK-EAR-420-dockerfile-netrc`).
  - **Sibling defect:** Auth, Logs, Provider and User Dockerfiles use the same token-only `insteadOf` line. Their next deploy is expected to fail the same way. User is in TASK-EAR-420 scope.
- **Gateway deployed to DEV (2026-11-03).**
  - PR #99 merged as `f0f5baa35bd4dc23ab5bdd327b5f59f807da667d` on top of `8706b68`.
  - Deploy STAGING run 41590204707 succeeded: `build-push` passed, then `deploy-ecs` passed.
  - ECS `api-gateway-staging` is on task definition 139 (`staging-sha-f0f5baa`), 1/1 running, rollout COMPLETED. Task `4dac6f2c…` started 06:32:42Z and is HEALTHY.
  - Boot log: all 22 gRPC services registered, zero panic or fatal lines.
  - Edge probe without a token, `https://api-test-gateway.gameslabs.app/api/v1/wallet/points/history`: 401 `UNAUTHORIZED` "Missing authorization header". The trailing-slash path also returns 401.
  - This shows the Auth middleware runs first. It does **not** prove the route exists.
  - **Still unverified:** an authenticated request through the DEV edge, which needs a player token. No sample response has been captured yet.
- **DEV authenticated capture (2026-11-03, operator via the Postman app; token and headers not shared).**
  - Request: `GET https://api-test-gateway.gameslabs.app/api/v1/wallet/points/history?limit=20&offset=0` → HTTP 200, `status.code` 200.
  - `data` is an array of 20 items.
  - `page` = `{size:"20", total:"215", totalPage:"11", limit:"20", offset:"0"}`. All int64 values are JSON strings, and totalPage = ceil(215/20).
  - Ordering is `earnedAt` DESC: 2026-10-15T06:44:46Z, then 06:44:12Z, …, down to 2026-09-09T07:01:52Z.
  - Item shape is `id`, `pointsEarned` (string), `earnedAt` (RFC3339 UTC), `reason`, `category`, `title`.
  - `point_turnover` → `play_game` / "Turnover Reward" (19 of the 20 rows).
  - `vip_level_reward` (2026-09-23) → `level_up` with title `""`. This is the expected legacy fallback: rows written before the deploy have no `level` metadata, and User does not send `level` yet.
  - Proves end to end: gateway route → Wallet RPC → caller scoping (only the token's own rows) → allowlist and JSON contract.
  - Observations for product:
    - (a) For this account, Earned is mostly turnover. 215 rows in total; the first page holds 19 turnover rows and 1 VIP row.
    - (b) No mission rows appear. Legacy mission POINT rows were stored under a date or id, which matches the documented coverage gap.

## Implementation: Order (2026-11-03)

PR: https://github.com/SparqLab/Games-Labs-Order/pull/88. Branch `task/TASK-EAR-420-used-currency-filter`, base `staging` `a5367df` (includes 419). Work was done in a separate worktree, `Games-Labs-Order-worktrees/TASK-EAR-420`, because the main Order checkout is on another lane's branch.

**What changed**
- Shared-lib pin bumped to `d816962`.
- The handler passes `currency` through to the service. The subject is still the caller only.
- The service accepts `""` (no filter) or `POINT` after trim and upper-casing; anything else is an invalid request.
- `buildUserRedemptionItemsWhere` adds `uri.price_currency = 'POINT' AND (CASE WHEN uri.price_amount > 0 THEN uri.price_amount ELSE uri.point_spent END) > 0`. The same predicate is shared by COUNT and the page query.
- Migration 042 already has `CHECK (price_currency IN ('POINT','DIAMOND'))`, so blank or other currencies cannot be stored. No schema change.

**RED** (`evidence/order-red-20261103.log`)
- The handler dropped `currency`.
- The service did not normalize `" point "`.
- The WHERE clause had no predicate.
- On Postgres, page 1 returned the DIAMOND and free rows, with total 6.

**GREEN** (`evidence/order-green-20261103.log`)
- `go vet` passes.
- `go test ./...` passes with `ORDER_TEST_POSTGRES_DSN`; the Postgres tests ran (checked with `-v`).
- The A/B caller test `TestListMyRedemptionItems_IgnoresRequestUserIDAndScopesToCaller` still passes.
- `-race` passes on the handler and service.

**Not done yet:** review, merge, DEV deploy, and an authenticated `?currency=POINT` capture.
- **Order review (Claude reviewer lane, 2026-11-03): approve with nits.** No blocking findings.
  - Verified:
    - The predicate matches `ResolveRedemptionPrice` for every storable row shape (042 NOT NULL + CHECK, legacy backfill).
    - Admin grants (POINT/0/0) are excluded.
    - COUNT and the page query share the same WHERE.
    - Results stay caller-scoped, and the empty-currency path is unchanged.
    - The pin bump does not touch anything Order imports.
    - 12 mutations, all caught.
    - `vet` and `vet -tags integration` pass, and CI `vet` passes.
  - Fixed in `2d204f9`:
    - #1: the repo now documents that it trusts the service's normalization.
    - #2: handler test confirming an invalid currency returns invalid-request.
  - Suite re-run green with Postgres (12 packages ok).
  - #3 (shared-lib comment mentions blank currency) left as is: it is harmless.
  - Review summary posted as PR comment 6597980018.
  - Note: CI runs `vet` only, so the Postgres tests run locally only.
- **Order merged and deployed to DEV (2026-11-03).**
  - PR #88 merged as `c24457801221d8a38bd08bdfb0751a33bb3e9804` (head `2d204f9`).
  - Deploy STAGING run 41597705953 succeeded (`build-push` and `deploy-ecs` both success).
  - ECS `games-labs-order-staging` is on td 108, image `staging-sha-c244578`, 1/1 running, rollout COMPLETED.
  - New task `48bc7cd6…` started 07:41:34Z and is HEALTHY.
  - Boot log: PostgreSQL connected → migrations applied (order; no new migration in this PR) → authadt connected → gRPC :50051 → HTTP :8087. Zero panic or fatal lines.
  - **Still to do:** an authenticated `GET /api/v1/my-redemption-items?currency=POINT` capture on DEV.
- **DEV authenticated Used capture #1 (2026-11-03, operator via the Postman app; recorded summary only — the response contains PII and voucher codes, so the body is not stored).**
  - Request: `GET https://api-test-gateway.gameslabs.app/api/v1/my-redemption-items` with `currency=POINT` (to be confirmed by the operator), `limit=20`, `offset=0`. Response: HTTP 200, `status.code` 200.
  - `items`: 20 rows, every one `priceCurrency: "POINT"` with `priceAmount` > 0 (5 to 1800). No DIAMOND rows and no zero-amount rows.
  - `page` = `{size:"20", total:"50", totalPage:"3", limit:"20", offset:"0"}`, with int64 values as strings.
  - Ordering is `createdAt` DESC (2026-10-05 → 2026-09-15).
  - Not proven yet: the unfiltered total for the same account (to show the filter actually removed rows), and `currency=DIAMOND` returning invalid-request.
- **DEV Used capture #2 (2026-11-03, operator via the Postman app):** `GET .../api/v1/my-redemption-items?currency=DIAMOND&limit=20&offset=0` returned body `status` = `{code: 1002, description: "currency must be POINT"}`, `items: []`, `page: null`.
  - The service rejection reaches the client as the invalid-request status. This is the same code family as the date-window validation.
  - The HTTP status line was not reported.
  - The unfiltered `page.total` for the same account has not been reported yet.
- **DEV Used capture #3 (2026-11-03, same account, no `currency`; summary only because of PII).**
  - HTTP 200. `page` = `{size:"20", total:"52", totalPage:"3", limit:"20", offset:"0"}`.
  - The first page includes 2 DIAMOND rows: redeemed 2026-09-21 (`priceAmount` 10) and 2026-09-22 (`priceAmount` 5), both with `pointSpent` 0. Their codes are `QA-DMD-…`, i.e. QA test data.
  - With `currency=POINT` the total was 50, so **52 − 50 = 2 = exactly the DIAMOND rows**. The POINT rows are identical in both lists, and no POINT row was dropped.
  - Result: the filter is proven on DEV through the gateway. COUNT and the page agree, and the unfiltered path is unchanged for existing callers.
  - Side fact for the POINT-only product rule: DIAMOND-priced owned rows **do exist on DEV** (QA test redemptions from 2026-09-21/22), so the defensive exclusion is not hypothetical there. Prod has not been checked.

## Implementation: User (2026-11-03)

PR: https://github.com/SparqLab/Games-Labs-User/pull/45. Branch `task/TASK-EAR-420-vip-level-metadata`, commit `31dd4da`, base `staging` `14e2eb5`.

**VIP level**
- `ports.WalletAdapter.CreditPoints` now takes `level int`.
- `payVIPLevelReward` passes the level being paid.
- The adapter adds `"level"` to the `/wallets/credit-points` request when level > 0.
- Amounts, the reason and the idempotency key are unchanged.

**Dockerfile:** switched from the token-only `insteadOf` URL to `.netrc`. This is the same git 2.54 break as api-gateway #99.

**RED** (`evidence/user-red-20261103.log`):
- The adapter request body had no `level`.
- The service passed level 0.

**GREEN** (`evidence/user-green-20261103.log`):
- `go vet` passes.
- `go test ./...` passes (8 packages ok).
- `-race` passes for the adapter and usersvc.

**Docker check:** with a real token, the old Dockerfile fails locally with the CI error. The new one builds from a clean `git archive` (the local `go.work` is gitignored and absent on CI).

**Not done yet:**
- Review, merge and DEV deploy.
- A new VIP POINT reward on DEV to show "Up To (VIP n)". This needs a real level-up; nothing synthetic was done.
- Sibling Dockerfiles still on the broken pattern: Auth, Logs, Provider. These are outside TASK-EAR-420.
- **User review (Claude reviewer lane, 2026-11-03): approve with nits.** No blocking findings.
  - **Verified:**
    - The payout is unchanged.
    - Every call that pays VIP points sends the level being paid: level-up, buy, immediate pay, and claim. On the claim path the level is read from the row under lock.
    - `/wallets/credit-points` has no other caller.
    - Wallet's decoder does not reject unknown fields, so the deploy order is free.
  - **Dockerfile:** git 2.54.0 confirmed. A clean build passes with the new Dockerfile and fails with the old one, with the CI error. No token or `.netrc` appears in any layer or in the history.
  - **Mutations:** all 9 that change the level were caught. Three others survived: the claim paying `row.Level+1`, a changed reason, and doubled points.
  - **Fixed in `7b0ed2b`:** the claim test now pins the level and key, and the buy test pins amount, reason and key. I re-ran the three mutations and all are now caught. The suite is green (8 ok).
  - **Noted:** this repo has no PR CI, so merging is the DEV deploy. The amd64 build was not checked. Review summary is in PR comment 6599020414.
- **User merged and deployed to DEV (2026-11-03).**
  - PR #45 merged as `7f29fab7edaff99e3751f86f67b0bcaa7c786e8f` (head `7b0ed2b`).
  - Deploy STAGING run 41605833151 succeeded: `build-push` passed, then `deploy-ecs` passed. This is the first CI build with the `.netrc` Dockerfile.
  - ECS `games-labs-user-staging` now runs td 72 with image `staging-sha-7f29fab`. It is at 1/1 and the rollout is COMPLETED.
  - New task `a5f763b8…` started 08:49:22Z and reports HEALTHY.
  - Still to see: an "Up To (VIP n)" title on a new VIP POINT reward, which needs a real level-up after the deploy.
- **Sibling Dockerfile fix (TASK-EAR-421, separate session):** PRs are open to `staging` and none is merged:
  - Auth #18
  - Logs #59
  - Provider #44
  - Per that session, old Provider images still contain GH_PAT in their image history (the old Dockerfile used `ARG GH_PAT`), so the token should be rotated after #44 deploys. I did not verify this claim here.

## Implementation: Missions (2026-11-03)

PR: https://github.com/SparqLab/Games-Labs-Missions/pull/146. Branch `task/TASK-EAR-420-earned-display-context`, base `staging` `6d5500c`.

**Display context on credits**

`CreditRequest` gains optional `day` and `activity_name`, filled in per producer:

| Reason | Field sent |
| --- | --- |
| `check_in_day` | `day` = claimed calendar day |
| `check_in_milestone` | `day` = claimed calendar day |
| `weekly_mission` (both claim paths) | `activity_name` = card title |
| `mission_event` | `activity_name` = event title |
| `daily_mission_group` | `activity_name` = DisplayName, falling back to Name |

- `daily_mission` has no name in scope at grant time, so its title stays empty.
- Payout fields and idempotency keys are unchanged.

**StoreHistory caller scoping**

StoreHistory now goes through `resolveOwner`:

| Request | Result |
| --- | --- |
| no `user_id` | the caller's own history |
| own id | allowed |
| other user's id | PermissionDenied |
| no identity | Unauthenticated |

- This is stricter than contract-review's "ignore a mismatched id": I matched the repo's existing owner-scoped RPC convention.

**Tests**

RED (`evidence/missions-red-20261103.log`):
- check-in credit `day` was 0;
- event, weekly and group `activity_name` were empty;
- StoreHistory with no `user_id` returned InvalidArgument.

GREEN (`evidence/missions-green-20261103.log`):
- `go vet` passes;
- `go test ./...` passes, 18 packages ok.

**Flagged, not done**

`GetInventory`, `GetMissionProgress`, `GetWeeklyMissions` and other bridged RPCs still forward the query `user_id`; whether their handlers re-check identity has not been audited. This is a separate defect-class sweep.

**Not done yet:** review, merge, DEV deploy, and an authenticated Purchase capture.
- **Missions review (Claude reviewer lane, 2026-11-03): approve with nits. Corrections recorded here.**
  - **Corrections to the section above:**
    - The milestone `day` is the milestone's configured day (the same number as on the milestone card), not a calendar day.
    - The group `DisplayName` is never loaded on the claim path (`db:"-"`). Fixed in `68a6a42`: admin groups send `Name`, and schedule-generated groups (`daily-sched-…`) send no title. Covered by new `TestDailyActivityGroupTitle`, which was seen failing on the old helper.
    - `daily_mission` *does* have `activity` in scope (`mission_service.go:230`). It was left out because schedule activity names are raw keys (for example `game_turnover`) and a correct title needs the resolved display name. This is a follow-up.
  - **Test gaps, noted and not fixed** (the code is correct in each case):
    - Check-in fixtures cannot tell the calendar day from a streak.
    - Weekly fixtures cannot tell `definition.Title` from `card.Title`, and the memory path is unguarded.
    - The milestone `day` is untested.
  - **No CI test gate:** merging #146 deploys DEV without CI running `go test`.
  - **Contract decision needed:** a mismatched StoreHistory `userId` now returns PermissionDenied (gateway 403), and no identity returns 401. contract-review.md and its Mobile reply still say "ignored".
  - **Coordination:** #147 (TASK-EAR-422) also edits `server.go`. Merge #146 first, or rebase.
  - The review summary is posted on the PR.
- **Missions merged and deployed to DEV (2026-11-03).**
  - PR #146 merged as `17ddcce07faecd6903092774702bc77a429025c6` (head `68a6a42`).
  - Deploy STAGING run 41609170116 succeeded: job `build-push` succeeded, then job `deploy-ecs` succeeded.
  - ECS `games-labs-missions-staging` is on td 160 with image `staging-sha-17ddcce`, 1/1 running, rollout COMPLETED.
  - New task `a22ae1e1…` started 09:15:03Z and is HEALTHY.
  - **Not verified yet:**
    - An authenticated Purchase capture on DEV.
    - New check-in, weekly, event and group POINT rows showing titles. This needs real claims on POINT-priced rewards; most mission rewards on DEV are configured as COIN.
- **Related PRs from other sessions, open and not merged:**
  - Missions #147 (TASK-EAR-422): owner-scope for bridged RPCs. Still CLEAN after #146 merged.
  - Missions #148 (TASK-EAR-423): closes public AddTurnover.
  - Auth #18, Logs #59 and Provider #44 (TASK-EAR-421): Dockerfile `.netrc` fix.
- **DEV Purchase capture #1 (2026-11-03, operator via the Postman app; summary only).**
  - Request: `GET https://api-test-gateway.gameslabs.app/api/v1/store/history`, no `userId`. Response 200 with `{history: [...]}`.
  - 34 rows, all with the caller's own `user_id`.
  - `item_type` values seen:
    - `pass`: 23 rows (Golden Pass, Pass test, Coin Booster, 2x Bonus Points, Mission Boost);
    - `exchange`: 7 rows;
    - `avatar`: 4 rows;
    - `package`: 1 row ("First Timer", stripe, 29 THB, `got_diamonds` 20, `got_coin` 2400).
  - Keys are snake_case and integers are JSON numbers, as contract-review.md describes. Newest first. No pagination; the full list comes back.
  - Observations for Mobile:
    - (a) `avatar` also appears. Purchase should filter to `item_type` ∈ {`package`, `pass`}.
    - (b) The stripe package row has `id: ""` and an empty `metadata.idempotency_key`, so `id` cannot be used as a list key. Use the row index or `item_id` + `created_at`.
    - (c) `metadata` carries internal keys (`wallet_idempotency_key`, `idempotency_id`). These are the caller's own rows, but Mobile should not display or depend on them.
  - The 403 check (`?userId=<other>`) has not been reported yet.
- **DEV Purchase capture #2 (2026-11-03, operator via the Postman app):** `GET .../api/v1/store/history?userId=00000000-0000-0000-0000-000000000001` with the same token returned body `{code: 7, message: "user_id does not match authenticated user", details: []}`.
  - gRPC code 7 is PermissionDenied, which grpc-gateway maps to HTTP 403 by default. The HTTP status line itself was not reported.
  - No history rows came back.
  - This confirms the StoreHistory cross-user read is closed on DEV, matching the operator's "403 per repo" decision.

## Mobile handoff (final API + mapping, 2026-11-03)

Delivered to the operator for the Mobile team. All three endpoints are live on DEV (`https://api-test-gateway.gameslabs.app`) and verified with an authenticated player token. Every call uses the logged-in session (`Authorization: Bearer <token>`).

**Do not send `userId`.** If it is sent, it must be the logged-in user's own id. Any other id returns 403 on Purchase and is ignored on Used and Earned.

### Purchase — `GET /api/v1/store/history`
- Response: `{ "history": [ ... ] }`, newest first. The whole list comes back in one response; there is no pagination.
- Keys are snake_case. Numbers are plain JSON numbers.
- Fields Mobile should use:

  | Field | Meaning |
  | --- | --- |
  | `item_type` | type of purchase |
  | `item_name` | item name |
  | `created_at` | RFC3339 UTC |
  | `pay_method` | e.g. `stripe`, `diamond` |
  | `price_thb` | price in THB |
  | `price_diamonds` | price in diamonds |
  | `got_diamonds`, `got_coin` | what the purchase granted |
  | `status` | purchase status |

- **Filter to `item_type` ∈ {`package`, `pass`}.** `exchange` and `avatar` rows also appear.
- Do not use `id` as the list key: stripe package rows have `id: ""`. Use `item_id` + `created_at`.
- Ignore `metadata`; it holds internal keys.
- Example row (DEV):

  ```json
  {"item_type":"package","item_name":"First Timer","created_at":"2026-08-24T09:35:56Z","pay_method":"stripe","price_thb":29,"price_diamonds":0,"got_diamonds":20,"got_coin":2400,"status":"success"}
  ```

- Another user's `userId` returns `{code: 7, message: "user_id does not match authenticated user"}` (HTTP 403).

### Point > Used — `GET /api/v1/my-redemption-items?currency=POINT&limit=20&offset=0`
- Response: `{ status, items: [...], page }`.
- `page` = `{size, total, totalPage, limit, offset}`. These are int64 values, sent as JSON strings.
- Default limit 20, max 100. Newest first.
- `currency=POINT` keeps only positive POINT spends. DIAMOND rows and free grants are excluded server-side, so do not filter in the app.
- Matching is case-insensitive. Any other currency returns `status.code` 1002 "currency must be POINT".
- Display:

  | Shown as | Field / rule |
  | --- | --- |
  | Points used | `priceAmount` if > 0, otherwise `pointSpent` (both are strings) |
  | Time | `redeemedAt` |
  | Name | `itemName` |

- Response items also include `contactEmail`, `shippingAddress` and `code`. Do not show those on this tab.
- DEV proof: the same account returns total 52 unfiltered and 50 with `currency=POINT`. The 2 rows removed are exactly the DIAMOND rows.

### Point > Earned — `GET /api/v1/wallet/points/history?limit=20&offset=0`
- Response: `{ status, data: [...], page }`. `data` is an array, `[]` when empty.
- `page` = `{size, total, totalPage, limit, offset}`, as strings.
- Default limit 20, max 100. Newest first.
- Item fields:

  | Field | Meaning |
  | --- | --- |
  | `id` | row id |
  | `pointsEarned` | positive; string int64 |
  | `earnedAt` | RFC3339 UTC |
  | `reason` | machine reason |
  | `category` | `quest`, `play_game`, `level_up` or `topup` |
  | `title` | display title; may be `""` |

- Localize the category labels:

  | `category` | Label |
  | --- | --- |
  | `quest` | Quest |
  | `play_game` | Play Game |
  | `level_up` | Level up |
  | `topup` | Top up |

- **When `title` is `""`, show the category label only.**
- Titles produced for new rows:

  | Source | Title |
  | --- | --- |
  | Check-in day | "Daily Login (D{calendar day})" |
  | Check-in milestone | "Check-in Milestone (D{milestone day})" |
  | Weekly, event, admin group | the activity name |
  | VIP | "Up To (VIP {level})" |
  | Turnover | always "Turnover Reward" |
  | Fixed | "Daily Streak", "Top Up Bonus" |

- `daily_mission` and schedule-generated groups have no title yet.
- Example (DEV):

  ```json
  {"id":"7735fd5a-…","pointsEarned":"20","earnedAt":"2026-10-15T06:44:46Z","reason":"point_turnover","category":"play_game","title":"Turnover Reward"}
  ```

- **Coverage limit:** rows written before 2026-11-03 keep `title: ""`.
- Legacy mission POINT rows were stored under a date or id instead of a reason. They are not in this list, and there is no backfill.
- Earned is therefore not a complete ledger, and Mobile must not sum it as a balance.

### Status of this handoff
- **Deployed and runtime-verified on DEV:** all three endpoints; caller scoping; the `currency` filter; pagination; JSON types.
- **Deployed, not yet runtime-observed:** titles on newly written VIP, check-in, weekly, event and group POINT rows. These need real claims of POINT-priced rewards.
- **Not deployed:** production. Production is cost-gated, and a separate promotion is needed.
- **Open product choice, stated explicitly:** whether incomplete legacy Earned coverage is acceptable to show. The Mobile follow-up message waits for product's answer on this. No backend change is pending on it.

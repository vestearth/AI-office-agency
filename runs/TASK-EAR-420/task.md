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
7. **Used reuse needs currency handling.** `ListMyRedemptionItems` (`Games-Labs-Order/internal/core/handlers/orderhdl/grpc.go:574`) returns `items` + `page` scoped to the authenticated caller. `UserRedemptionItem` carries pointSpent, redeemedAt, itemName, priceCurrency, and priceAmount. DIAMOND redemption rows also exist; keep them out of Point > Used. Define handling of legacy empty currency as POINT and zero-cost/admin-granted rows. Do not confuse a point-spend record with voucher-consumption status.

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

Thanks for the details. For Purchase history, we can reuse `GET /api/v1/store/history` for Package and Special Pass records. For Point > Used, we can reuse `GET /api/v1/my-redemption-items`, with POINT and DIAMOND redemptions handled separately.

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

## Parallel preparation packet — 2026-11-03

The operator requested preparing 420 in parallel while 419 acceptance is pending. See [api-contract-draft.md](api-contract-draft.md) for proposed proto additions, JSON examples, field semantics, metadata ownership, and the RED/GREEN regression matrix. This supersedes no implementation/release gate; downstream execution and deployment remain in the documented order.
- **Product rule: item redemption is POINT-only** (App team, 2026-11-03, after confirming with Christy; recorded in `docs/GAMES_LABS_PROJECT_CONTEXT.md` → Product rules). For Point > Used, keep the server-side `currency=POINT` filter. It still excludes zero-cost/admin grants and any leftover DIAMOND rows, and whether such rows exist has not been checked. In the held Mobile follow-up, describe it as "POINT spends only, free grants excluded", not as separating DIAMOND redemptions.

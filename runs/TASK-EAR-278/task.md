# TASK-EAR-278 — Add Mobile Stripe Checkout Status Contract

## Summary

- Short name: `mobile-stripe-checkout-status`
- Type: feature
- Workstream: backend / shared API contract / payment fulfillment
- Priority: high
- Created: 2026-08-18
- Target environment: staging first
- Execution: shared-lib publication is a sequential hard gate; after it is
  published, Wallet and API Gateway may execute in parallel with separate repo
  ownership, while merge/deploy remains ordered.

## Goal

Complete the backend contract required for Mobile to resume and poll a Stripe
package checkout by the internal Wallet transaction id, and to enter its success
flow only after the package reward is durably fulfilled.

Preserve the working create-checkout and idempotent-replay behavior. Add an
authenticated, ownership-safe status API with explicit payment and fulfillment
states, authoritative amount/currency, actual granted rewards, expiry, and
timestamps. Prove the complete flow in the `xpinext sandbox` against Games Labs
staging before making any production claim.

## Stakeholder contract

Mobile has confirmed the following intended behavior:

- Send the normal bearer token with `provider = "stripe"` and
  `type = "deposit"`.
- Persist `idempotency_id` before creating checkout.
- Persist `transaction.id` after the create response.
- If create times out, retry the same request with the same `idempotency_id` and
  receive the same transaction and `cashier_url`.
- Poll status by the returned internal `transaction.id`.
- Treat redirect through `cancel_url`, closing Checkout, app restart, and
  foreground resume as non-terminal; continue polling.
- Enter the success flow only when `fulfillment_status = "fulfilled"`.
- Do not infer payment outcome from wallet balance changes.

## Verified current state (2026-08-18)

### Already implemented

- `POST /api/v1/transaction` is declared by `paymentpb.PaymentService` and
  registered by current `api-gateway` staging source.
- Wallet derives player identity from gateway metadata and fails closed without
  it; request-body `user_id` is not authoritative.
- Stripe package checkout starts as pending. A client cannot self-select a paid
  status.
- `idempotency_id` is accepted in the request body or forwarded metadata.
- A sequential retry with the same id returns the existing Wallet transaction,
  Stripe Checkout Session, and `cashier_url`; it does not create a new session.
- The create response contains:
  - `transaction.id`: internal Wallet payment-transaction UUID.
  - `cashier_url`: Stripe-hosted Checkout URL.
  - `api_order_id`: Stripe Checkout Session id (`cs_...`), not an internal order.
- For a request with `order_package_id`, Wallet loads the active package from
  Order, derives the amount from `PriceTHB`, and rejects a conflicting positive
  client amount. Currency is THB.
- The signed Stripe webhook handles paid, async success/failure, expired,
  PaymentIntent failure, and PaymentIntent cancellation events. Paid package
  fulfillment grants rewards and records purchase history.
- Focused `paymentsvc` and `paymenthdl` tests pass on the current checkout.
- Wallet and API Gateway have successful staging deployment runs containing the
  current create flow.

### Missing or semantically incomplete

- `PaymentService` exposes only `CreateTransaction`; there is no public status
  read RPC/HTTP endpoint.
- There is no ownership-scoped lookup by `transaction.id` for Mobile.
- The current stored statuses are `created`, `pending`, `success`, `failed`,
  `cancelled`, and `timeout`; they do not directly implement Mobile's requested
  `pending`, `processing`, `paid`, `failed`, and `expired` contract.
- `checkout.session.expired` currently persists `cancelled`, not an explicit
  client-facing `expired` state.
- No explicit `fulfillment_status` is persisted or returned.
- Actual granted Coin/Diamond amounts and Stripe `expires_at` are not first-class
  payment fields in the public contract.
- The Android DEV checkout repository remains contract-unavailable. Android is a
  read-only reference repository for every AI agent and is not modified by this
  task.

## Proposed API design

Treat this as the implementation contract for the task unless the operator or
Mobile explicitly overrides it before the shared-lib PR. Any change to route,
status vocabulary, fulfillment boundary, or money semantics must be recorded as
a product/API decision in this task before downstream implementation proceeds.

### Endpoint

Add an additive RPC to `paymentpb.PaymentService`:

```proto
rpc GetTransactionStatus(GetTransactionStatusRequest)
    returns (GetTransactionStatusResponse) {
  option (google.api.http) = {
    get: "/api/v1/transactions/{transaction_id}/status"
  };
}
```

The route is authenticated by the normal API Gateway bearer-token flow.

### Authorization and lookup

- The client supplies only `transaction_id` in the path.
- Wallet derives `user_id` from trusted gateway metadata.
- Repository lookup must constrain both transaction id and authenticated user
  id. It must never load by id and authorize afterwards.
- Missing and cross-user ids return the same stable not-found result so the
  endpoint cannot be used to enumerate another player's payments.
- Do not accept `user_id`, provider transaction id, Checkout Session id, or
  `idempotency_id` as alternative public lookup authority in this endpoint.

### Response

Add a dedicated additive response message rather than changing the meaning of
the existing `PaymentTransaction.status` field:

```json
{
  "status": { "code": 200, "description": "OK" },
  "transaction_id": "wallet-transaction-uuid",
  "api_order_id": "cs_test_...",
  "order_package_id": "package-uuid",
  "payment_status": "pending",
  "fulfillment_status": "not_started",
  "granted_coin": 0,
  "granted_diamond": 0,
  "paid_amount": 29.0,
  "currency": "THB",
  "expires_at": "2026-08-18T10:30:00Z",
  "updated_at": "2026-08-18T10:00:00Z"
}
```

Contract requirements:

- `transaction_id`: internal Wallet payment-transaction id.
- `api_order_id`: Stripe Checkout Session id. Keep this legacy field name for
  create-response compatibility; document its Stripe meaning.
- `order_package_id`: package snapshot identity for this checkout.
- `payment_status`: exactly one of `pending`, `processing`, `paid`, `failed`, or
  `expired`.
- `fulfillment_status`: exactly one of `not_started`, `processing`, `fulfilled`,
  or `failed`.
- `granted_coin` and `granted_diamond`: exact reward amounts committed for this
  transaction. They are zero until fulfillment succeeds and must not be derived
  from the player's current balance.
- `paid_amount`: server-authoritative checkout amount for the transaction. For
  this task it is THB and matches the Stripe Checkout amount. Existing storage
  uses the major-unit amount; do not introduce a second conflicting money
  authority.
- `currency`: uppercase ISO currency code; `THB` for this flow.
- `expires_at`: Stripe Checkout Session expiry captured when the session is
  created.
- `updated_at`: timestamp of the latest durable payment/fulfillment state
  transition.
- New proto fields must be additive and use previously unused field numbers.
- Generated Go, gRPC-gateway, and Swagger artifacts must be regenerated from
  proto source and never edited manually.

### State machine

#### Create and resume

- Newly created open Checkout Session:
  - `payment_status = pending`
  - `fulfillment_status = not_started`
- Sequential retry with the same `idempotency_id` returns the same transaction,
  `cashier_url`, `api_order_id`, amount, currency, and expiry.
- Closing Checkout, backgrounding the app, or visiting `cancel_url` does not
  change backend state.

#### Stripe events

- `payment_intent.processing` or an equivalent asynchronous Stripe processing
  signal: `payment_status = processing` while fulfillment remains
  `not_started`.
- Signed paid event:
  1. durably claim/enter fulfillment for the transaction;
  2. expose `fulfillment_status = processing` while work is in progress;
  3. grant the package reward idempotently;
  4. persist the exact granted Coin/Diamond amounts;
  5. finish with `payment_status = paid` and
     `fulfillment_status = fulfilled` only after the reward commit succeeds.
- Signed payment/async failure: `payment_status = failed`. If fulfillment was
  never attempted, keep `fulfillment_status = not_started`; if it was attempted
  and failed, return `failed`.
- `checkout.session.expired`, or backend-confirmed explicit Stripe Session
  expiration: `payment_status = expired`.
- `cancel_url` navigation alone is never proof of cancellation or expiry.
- Duplicate, reordered, or retried webhook delivery cannot duplicate rewards,
  regress a terminal state, or overwrite granted amounts.
- Terminal precedence must be documented and tested. A late failure/expiry
  event cannot move a paid/fulfilled transaction backwards.

### Fulfillment definition

For Mobile, `fulfilled` means the Wallet payment completion and the package Coin
and Diamond reward mutation have committed idempotently. Missions purchase
history remains an observable downstream side effect and must be verified in
staging, but Mobile must not infer fulfillment from wallet balance deltas or
Missions history.

### Price and discount decision

- Wallet remains the amount authority for Stripe package checkout.
- Mobile should omit `amount` when `order_package_id` is present. A matching
  amount remains accepted for compatibility; a conflicting positive amount is
  rejected.
- Currency remains server-selected THB.
- Coupons and personalized discounts are not reachable on this path today.
  This task must not invent or apply them. `paid_amount` is the current
  authoritative undiscounted package `PriceTHB`.
- If product wants `discount_percent` or coupons applied to direct Stripe
  package checkout, open a separate Order-owned pricing-contract task before
  changing payment behavior.

## Scope and ownership

| Repository | Ownership and expected work |
| --- | --- |
| `shared-lib` | Extend `proto/paymentpb/payment.proto` additively; generate Go, grpc-gateway, and Swagger artifacts; document fields/status values; publish first. Target `main`. |
| `Games-Labs-Wallet` | Bump published `shared-lib`; add ownership-safe status lookup; persist explicit payment/fulfillment state, expiry, and granted reward snapshot as needed; update Stripe create/webhook transitions; add focused repository/service/handler tests and migration if schema changes. Target `staging`. |
| `api-gateway` | Bump the same published `shared-lib`; confirm PaymentService registration, bearer identity forwarding, HTTP route, Swagger/Postman contract, and focused gateway tests. Target `staging`. |
| `Games-Lab-Android` | Read-only reference only. Compare DTO and polling expectations; do not create, edit, format, generate, commit, push, or open a PR in this repo. Human Mobile lane owns implementation. |

## Explicitly out of scope

- Production Stripe configuration, production deploy, or real-money acceptance.
- Editing `Games-Lab-Android` by any AI agent.
- Replacing Stripe Checkout with Payment Element or a native payment SDK.
- Coupon, promotion, or catalog `discount_percent` product design.
- Subscription, refund, dispute, chargeback, payout, or Connect flows.
- A generic payment-history/list API.
- Fixing the known simultaneous-create race in which two truly concurrent
  requests with one unseen `idempotency_id` can both reach Stripe. Sequential
  timeout retry is already covered; concurrency hardening requires a separate
  locking design unless implementation demonstrates it is necessary for this
  endpoint.
- Inferring payment success from wallet balance changes.

## Ordered implementation plan

### Phase 1 — Shared contract (hard gate)

1. Confirm unused protobuf field numbers and current generated-artifact command.
2. Add `GetTransactionStatus` request/response messages and the HTTP annotation
   additively in `shared-lib`.
3. Define stable lowercase string values and document unknown/fallback behavior
   for older/newer client combinations.
4. Regenerate Go, gRPC-gateway, and Swagger artifacts.
5. Run shared-lib focused tests/build and verify generated diffs.
6. Open a `shared-lib` PR against `main`.
7. Stop. A human publishes/merges the shared contract and provides the commit or
   pseudo-version. Do not create local duplicate message types or use a local
   `replace` in consumers.

### Phase 2 — Wallet persistence and behavior

1. Branch from current `origin/staging`; bump to the published shared-lib
   pseudo-version and run `go mod tidy`.
2. Add red-first tests for ownership isolation, initial status, processing,
   paid/fulfilled, failure, expiry, duplicate/reordered webhook delivery, and
   exact reward amounts.
3. Reuse `payment_transactions` as the owning aggregate. Add only the minimal
   migration/columns required for state, reward snapshot, and expiry; do not
   create a parallel payment table.
4. Populate expiry from the actual Stripe Checkout Session returned by the
   adapter and preserve it during idempotent replay.
5. Implement the authenticated status handler/service/repository lookup by
   `(transaction_id, user_id)`.
6. Implement explicit Stripe-to-client status transitions without changing
   existing non-Stripe payment behavior.
7. Persist exact granted rewards from the same package snapshot used by
   fulfillment and keep duplicate delivery idempotent.
8. Keep create response behavior backward compatible.
9. Run focused tests, all Wallet tests, vet, readonly build, migration review,
   and `git diff --check`.

### Phase 3 — Gateway adoption

1. Branch from current `origin/staging`; bump to the exact published shared-lib
   pseudo-version and run `go mod tidy`.
2. Confirm PaymentService registration exposes the new GET route through the
   authenticated gRPC-gateway path.
3. Verify bearer identity is forwarded as trusted `userid` metadata and that
   spoofed client identity headers cannot retarget the lookup.
4. Refresh Swagger/Postman material from the generated contract; remove or
   correct stale text claiming PaymentService is unregistered.
5. Run gateway tests, vet, readonly build, and `git diff --check`.

### Phase 4 — Review and staging rollout

1. Review shared-lib compatibility and consumer pseudo-version alignment.
2. Merge/deploy in order: shared-lib publication → Wallet staging → API Gateway
   staging.
3. Do not deploy consumers before the shared contract is published.
4. Preserve old create clients during partial rollout; Mobile must not ship the
   polling flow until both Wallet and Gateway status API are deployed.

### Phase 5 — Authenticated staging acceptance

Using an authorized QA player and `xpinext sandbox`:

1. Create a Stripe package checkout with bearer token, `provider = stripe`,
   `type = deposit`, `order_package_id`, and a persisted `idempotency_id`.
2. Retest the create request with the same id and prove the raw response returns
   the same `transaction.id`, `cashier_url`, and `api_order_id`.
3. Poll the new status endpoint and retain the raw `pending` response.
4. Close Checkout or follow `cancel_url`; prove status remains pending.
5. Complete a sandbox payment; retain Stripe Event Delivery body/status and
   prove signed webhook delivery returns `2xx`.
6. Poll until the raw response is `payment_status = paid` and
   `fulfillment_status = fulfilled` with the exact package Coin/Diamond values,
   amount, currency, expiry, and updated timestamp.
7. Verify the Wallet reward ledger and Missions purchase history for that exact
   transaction/idempotency id. Report those as separate evidence layers.
8. Replay the paid webhook and prove no duplicate reward and no state
   regression.
9. Run separate failure and natural-expiry cases. Prove `cancel_url` alone does
   not create an expiry.
10. Attempt another player's transaction id and prove the response does not
    disclose its existence or data.

## Acceptance criteria

1. Existing Mobile clients can continue using `POST /api/v1/transaction`
   without request or response breakage.
2. A bearer-authenticated player can call
   `GET /api/v1/transactions/{transaction_id}/status` only for their own
   transaction.
3. Cross-user and unknown ids have the same stable not-found behavior.
4. The response contains every approved field with documented semantics and
   stable lowercase status values.
5. Mobile can determine success solely from
   `fulfillment_status = fulfilled`; no balance-delta inference is needed.
6. Sequential retry with the same `idempotency_id` returns the same transaction,
   Checkout URL, Checkout Session id, and expiry and creates one Stripe Session.
7. Package amount comes from the active Order package; omitted client amount is
   accepted, matching amount remains compatible, and mismatched amount is
   rejected. Currency is THB and no discount is silently applied.
8. `cancel_url` or app closure does not alter payment state.
9. Natural/explicit Stripe Session expiry returns `payment_status = expired`.
10. Paid webhook processing grants the package once and returns exact granted
    Coin/Diamond values with `payment_status = paid` and
    `fulfillment_status = fulfilled` only after reward commit.
11. Failure, duplicate, reordered, and replayed events cannot duplicate rewards,
    regress terminal state, or mutate the original payment authority fields.
12. Proto/gateway/Swagger/Postman artifacts are aligned; generated code is not
    hand-edited.
13. `shared-lib`, Wallet, and Gateway use the same published contract version;
    no consumer has a local `replace`, and `go.mod` plus `go.sum` move together.
14. Focused red-before/green-after tests, full repository tests, vet, readonly
    builds, and diff checks pass in each changed repo.
15. Staging source, PR, deploy, authenticated API, Stripe delivery, Wallet
    reward, and Missions history evidence are reported separately. No
    production claim is made.

## Compatibility matrix

| Client/server combination | Required behavior |
| --- | --- |
| Old Mobile + new backend | Existing create flow remains compatible; added RPC/fields do not change old JSON semantics. |
| New Mobile + old backend | Mobile feature remains disabled until status endpoint capability is confirmed; do not infer from `404` alone during rollout. |
| New Mobile + new backend | Persist idempotency before create, transaction id after response, poll status, and succeed only on fulfilled. |
| Duplicate create retry | Same transaction and Stripe Session are returned. |
| Duplicate/reordered webhook | Idempotent no-op or monotonic transition; no duplicate reward. |
| Cross-user lookup | Same not-found contract as an unknown id; no data disclosure. |

## Risks and mitigations

- **Money/reward correctness — critical:** keep price and fulfillment authority
  server-side; test underpayment, overpayment, duplicate webhook, and terminal
  state regression.
- **Shared contract drift — high:** publish shared-lib first and pin the exact
  pseudo-version in Wallet and Gateway.
- **Partial rollout — high:** Mobile polling remains disabled until both
  consumers deploy; additive proto changes preserve old clients.
- **Status ambiguity — high:** use a dedicated client status response and an
  explicit state machine; do not silently reinterpret all legacy payment rows.
- **Cross-user leakage — high:** query by transaction and authenticated user in
  one repository operation.
- **Fulfillment observability — medium:** persist exact granted amounts and
  state; verify Wallet ledger and Missions history separately.
- **Legacy rows — medium:** define deterministic mapping/defaults for Stripe
  transactions created before new columns exist and cover them in migration
  tests. Never report an old successful transaction as fulfilled unless durable
  evidence supports it.
- **Android ownership — hard prohibition:** AI agents may inspect but never edit
  `Games-Lab-Android`.

## Agent handoff and sequencing

- Recommended primary role: `dev-2`.
- Parallel implementation: allowed only after the shared-lib publication gate.
  Wallet and API Gateway then have separate repo ownership, but neither may
  diverge from the published contract version and deployment remains Wallet
  before Gateway.
- Suggested Cursor/Claude split:
  1. Claude: contract review and `shared-lib` protobuf/generated-artifact lane.
  2. Human publish gate: merge/publish shared-lib and record its pseudo-version.
  3. Cursor: Wallet persistence/service/handler/tests lane.
  4. Claude: API Gateway dependency/docs/test lane and cross-repo review.
  5. Reviewer/DevOps: independent verification and staging rollout.
- Agents are not alone in the workspace. Each lane owns only its assigned repo,
  must preserve other edits, and must never revert another lane's changes.

## Verification commands

Use repository-native commands where available. At minimum:

```bash
# shared-lib
GOWORK=off go test ./...
GOWORK=off go vet ./...
GOWORK=off go build -mod=readonly ./...
git diff --check

# Games-Labs-Wallet
GOWORK=off go test ./...
GOWORK=off go vet ./...
GOWORK=off go build -mod=readonly ./...
git diff --check

# api-gateway
GOWORK=off go test ./...
GOWORK=off go vet ./...
GOWORK=off go build -mod=readonly ./...
git diff --check
```

Record exact commands, repo SHA, pass/fail, PR target, deployment run, and raw
runtime assertions in the task evidence ledger/output. A successful build or
deploy is not authenticated payment-flow acceptance.

## Definition of done

This task is done only when:

- the shared contract is published and adopted by Wallet and Gateway;
- source, generated artifacts, tests, builds, and dependency alignment pass;
- PRs target the required branches (`shared-lib: main`, Wallet/Gateway:
  `staging`);
- Wallet and Gateway staging deployments succeed;
- authenticated raw create/retry/status responses and Stripe signed delivery
  prove pending, fulfilled, failed, expired, duplicate, and cross-user cases;
- exact package rewards are verified without using balance changes as status;
- remaining production work is explicitly reported as unverified.

## Next action

Start Phase 1 in `shared-lib` from current `origin/main`. Before any consumer
implementation, finalize the additive proto field numbers, regenerate artifacts,
open the shared-lib PR, and stop at the human publication gate.

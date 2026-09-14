# TASK-EAR-352 — Persist the Package payment gateway at instrument level and stamp it into the Store Player Log

## Type

feature (contract + schema, 4 repos)

## Workstream

backend

## Priority

medium

## Created

2026-09-12

## Parent

TASK-EAR-346 Wave 1 (Store Player Log), TASK-EAR-351 Wave 2 item D (parked
there; split out here because it spans Wallet, shared-lib, Order, and the
gateway pin). Operator/product decisions taken 2026-09-12:

- **Level = instrument** (not PSP): Apple Pay / Google Pay / Credit/Debit
  Card / PromptPay. **Ubit is treated as unused (operator, 2026-09-12)** —
  not in the vocabulary, not wired, not tested.
- **Vocabulary (exact display strings):**
  - Stripe `card` with `wallet.type = apple_pay` → `Apple Pay`
  - Stripe `card` with `wallet.type = google_pay` → `Google Pay`
  - Stripe `card` with no wallet (or another wallet) → `Credit/Debit Card`
  - Stripe `promptpay` → `PromptPay`
  - anything else / not captured → **empty** (never "Unknown")
- **Historical rows stay dashes.** No backfill of any kind; the coverage
  boundary is the first order confirmed after this ships.
- Diamond Wallet purchases keep `N/A` (unchanged from Wave 1).

## Goal

Every new Package purchase shows a truthful `Payment Gateway` in Monitoring →
Player Log → Store, captured from the PSP at payment confirmation and
persisted on the order, so the Store event stamps an immutable fact. Never
derived from `payment_reference` format, never joined at Logs query time.

## Current evidence (verified read-only 2026-09-12)

- **Authoritative source is Wallet, not Order.** Store payments settle
  through Wallet's signature-verified Stripe webhook
  (`Games-Labs-Wallet/internal/core/services/paymentsvc/stripe_callback.go`);
  `handleStripeCheckoutCompleted` unmarshals the `checkout.session.completed`
  event and `completeStripeCheckoutSuccess` only keeps
  `sess.PaymentIntent.ID`. The webhook body carries the PaymentIntent **id
  only**, not `payment_method_details`.
- Wallet's `payment_transactions` already persists `Provider`
  (`stripe` / `ubit`, `internal/models/payment.go:205-206`) but nothing
  about the instrument. `StripeAdapter` (`internal/core/ports/adapters.go:35`)
  exposes Create/Get/Expire checkout session only; `GetCheckoutSessionState`
  calls `session.Get(sessionID, nil)` with no expand.
- stripe-go is `v82.5.1`. `PaymentIntent.LatestCharge *Charge` and
  `Charge.PaymentMethodDetails.Type` + `.Card.Wallet.{ApplePay,GooglePay}`
  (`charge.go:1086`) give the instrument; a PaymentIntent retrieve with
  `expand[]=latest_charge` (or `session.Get` with
  `expand[]=payment_intent.latest_charge`) is required.
- Wallet → Order handoff: `package_fulfillment.go:139-148` calls
  `orderadt` with `PaymentReference` only; `orderpb.ConfirmPaymentRequest`
  has `id` and `payment_reference` (`shared-lib/proto/orderpb/order.proto:558`).
- Order: `orders` has `payment_reference` (migration 004) and no gateway
  column; `models/order.go:57` `PaymentReference *string`;
  `ConfirmPayment` at `ordersvc/service.go:609`; the Store event is built in
  `publishStorePurchaseSettled` (`service.go:2616`) and never sets
  `PaymentGateway`. Latest Order migration is `042`.
- **Wave 1 guard test** `ordersvc/service_test.go:2161` asserts the Package
  gateway stays empty. It must be **rewritten** to assert "empty when not
  persisted, exact value when persisted" — never deleted.
- shared-lib event contract already has `PaymentGateway string`
  (`events/player_activity.go:171`) and Logs/gateway/Backoffice already
  render it (Wave 1). **No Logs, Backoffice, or monitoringpb change is
  needed** unless the display string mapping is moved to the UI (it is not:
  the string is stamped server-side, see Locked decisions).
- Ubit path (`paymentsvc/ubit_deposit.go`, demo deposit) is declared unused
  by the operator; a `ubit` provider row maps to `""` like any unknown.

## Locked decisions

- **Capture at Wallet on the settled webhook, persist on Wallet's
  transaction, forward to Order in the same ConfirmPayment call, persist on
  the order, stamp into the event.** One capture point, three durable copies
  in causal order; nothing is inferred later.
- The display string is resolved **once, in Wallet**, from Stripe's typed
  fields into the vocabulary above and travels as the final string
  (`payment_gateway`). Order and Logs store and forward it verbatim. Reason:
  Wallet is the only service that sees the PSP object; keeping raw
  `card/apple_pay` codes in Order would push vocabulary into three repos.
- Empty string = not captured (Stripe retrieve failed, unknown type). A
  retrieve failure must **not** fail or delay fulfillment: capture is
  best-effort after the payment is already confirmed by signature; log it,
  persist empty, continue. Money path behavior is unchanged.
- Additive contract only: `orderpb.ConfirmPaymentRequest.payment_gateway`
  new field number; `Order` message gets `payment_gateway` for admin
  reads. Existing clients unaffected.
- Schema: Wallet `payment_transactions.payment_gateway VARCHAR(64) NOT NULL
  DEFAULT ''` (migration 020, latest is 019) and Order
  `orders.payment_gateway VARCHAR(64) NOT NULL DEFAULT ''` (migration 043),
  both `ADD COLUMN IF NOT EXISTS`, forward-only, no backfill. Order and
  Wallet replay migrations on boot — every statement idempotent; no
  ADD-then-DROP pairs (pg_attribute slot burn, see TASK-EAR-331/335).
- Historical rows: no update statement of any kind. Coverage note in the run
  records the first order id/timestamp that carries a value on staging.
- `Games-Lab-Android/` read-only. No prod ECS/RDS start. Prod deploy is a
  separate train.

## Scope

In:

1. **Wallet** — extend `StripeAdapter` with a retrieve that returns the
   instrument (`payment_method_type`, `card_wallet_type`) for a PaymentIntent
   or session; map to the vocabulary in one pure function with table tests
   (`card+apple_pay`, `card+google_pay`, `card`, `promptpay`, unknown
   type, non-stripe provider → ""); persist on `payment_transactions`; pass to Order.
   Migration + boot-replay idempotency test.
2. **shared-lib** — additive `payment_gateway` on `ConfirmPaymentRequest` and
   `Order`; regenerate; publish before downstream pins.
3. **Order** — persist `payment_gateway` at `ConfirmPayment` (only when the
   caller supplies it; an empty value never overwrites a non-empty stored
   value), expose on `Order` reads, stamp into the Store event; rewrite the
   guard test; migration 043 + drift test.
4. **api-gateway** — shared-lib pin bump if the `Order` JSON shape is
   consumed by admin routes (verify by grepping the raw response body, not by
   a green build — the gateway owns the wire format).
5. Staging acceptance with real Stripe test-mode fixtures.

Out:

- Backfill of any historical row (product decision: dashes stay).
- Logs, Backoffice, monitoringpb changes (Wave 1 already renders the field).
- Any change to fulfillment ordering, wallet credit, or coupon logic.
- Prod.

## Acceptance criteria

- Unit: vocabulary mapper table test covers all five cases (four values +
  empty); Order test proves
  empty-never-overwrites and the event carries the persisted string; Wallet
  test proves a Stripe retrieve failure still confirms the order with `""`.
- Staging, per fixture (Stripe test mode): card → `Credit/Debit Card`;
  PromptPay → `PromptPay`; Apple Pay / Google Pay if the test-mode wallet
  path is reproducible, otherwise documented as unit-only with the Stripe
  fixture JSON and explicitly listed as not runtime-verified.
- Raw evidence chain per fixture: Stripe event → Wallet transaction row →
  Order `ConfirmPayment` request → `orders.payment_gateway` → Store event
  payload → `GET /admin/monitoring/player-logs/store` body → UI cell.
- Pre-cutoff Package rows still show a dash; Diamond rows still `N/A`.
- Focused tests green in Wallet, Order, shared-lib; `go.mod`/`go.sum`
  together, no `replace`; `GOWORK=off go build -mod=readonly ./...` in each.
- Migrations replay cleanly on a second boot (no error, no slot churn).

## Release sequence

1. shared-lib → main (publish pin).
2. Order → staging (migration 043 boots; field accepted but empty until
   Wallet sends it — safe intermediate state).
3. Wallet → staging (migration boots; starts capturing and forwarding).
4. api-gateway pin bump only if step 4 in Scope proves it is needed.
5. Run staging fixtures; record cutoff order id.

Rollback: revert the Wallet forward (field goes empty again); columns stay
(additive, default ''). No data rollback needed.

## Risks

- **Stripe retrieve latency/failure on the webhook path** — mitigated by
  best-effort capture after signature verification; must be proven by test
  and by a staging run with the retrieve forced to fail (fault injection via
  an invalid expand or a stubbed adapter, documented).
- **Vocabulary drift** — single mapper in Wallet, table-tested; no other
  repo interprets codes.
- **Guard-test regression** — Wave 1 test rewritten with both branches.
- **Gateway wire format** — bitten 5x before; prove with a raw body grep.

## Assignment

- Next agent: `dev-2`
- Parallel: false until shared-lib is published; then Wallet and Order may
  proceed in parallel (both depend only on the pin).
- Estimated complexity: high (4 repos, 2 migrations, PSP integration).

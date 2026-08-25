# TASK-EAR-279 — Record Stripe payment as paid when package fulfillment fails

## Summary

- Short name: `stripe-fulfillment-failure-payment-status`
- Type: bugfix
- Workstream: backend / payment fulfillment
- Priority: high
- Created: 2026-08-18
- Target environment: staging first
- Origin: blocking review finding on TASK-EAR-278 Wallet PR #25, merged before
  the review landed (see Provenance)

## Goal

When a signed Stripe paid event is followed by a fulfillment failure, the
transaction must record that the payment itself succeeded. Today it does not:
the row keeps `payment_status = "pending"` even though Stripe already captured
the money.

Fix the state written on the fulfillment-failure branch, add the regression test
that branch has never had, and keep the fulfillment-retry path open.

## Defect

`internal/core/services/paymentsvc/stripe_callback.go:159` (on `origin/staging`):

```go
func (s *service) failStripeFulfillment(ctx context.Context, transactionID string, cause error) error {
	_, _ = s.pr.CompletePaymentTransaction(ctx, models.CompletePaymentTransactionInput{
		ID:                transactionID,
		FulfillmentStatus: models.FulfillmentFailed,
	})
	return cause
}
```

`PaymentStatus` is left empty, and `CompletePaymentTransaction` treats an empty
value as "leave unchanged". After Stripe has captured the money the row is:

```
payment_status     = "pending"   (or "processing")
fulfillment_status = "failed"
status             = "pending"
```

Reached only from the paid handler `completeStripeCheckoutSuccess`, via four
call sites — lines 125, 128, 132, 138. The realistic trigger is
`loadActivePurchasePackage` failing because an admin deactivates the package
while the player is sitting on the Stripe Checkout page; packages are
admin-editable, so this is a live-ops path, not a theoretical one.

### Impact

1. **The public contract is violated.** `paymentpb` documents `"pending"` as
   "checkout created, no confirmed provider outcome yet". The player has been
   charged, so that statement is false. Support triaging an "I paid and got
   nothing" ticket sees a row claiming no provider outcome was ever confirmed.
2. **A captured payment stays mutable.** Because `payment_status` never advances
   to `paid`, `models.CanApplyStripeFailureOrExpiry` still returns true for the
   row, so a later failure or expiry event can stamp `expired` onto a payment
   Stripe actually captured.
3. **Zero test coverage.** `FulfillmentFailed` appears in no `_test.go` file on
   `origin/staging`.

Mobile is not left in a spin: the documented client rule is to enter the success
flow only on `fulfillment_status = "fulfilled"`, and `failed` is a terminal
signal. The damage is to contract truthfulness, support triage, and the
mutability of a settled payment — not to reward correctness.

## Required fix

Add the payment status to the same input:

```go
_, _ = s.pr.CompletePaymentTransaction(ctx, models.CompletePaymentTransactionInput{
	ID:                transactionID,
	PaymentStatus:     models.PublicPaymentPaid, // Stripe already captured; only fulfillment failed
	FulfillmentStatus: models.FulfillmentFailed,
})
```

### Hard constraint — do not set the internal status

Do **not** also set `Status: models.PaymentStatusSuccess`.
`ClaimPaymentFulfillment` (`internal/repositories/payment.go`) guards on:

```sql
AND COALESCE(fulfillment_status, '') IN ('', $3, $2, $4)   -- '', not_started, processing, failed
AND COALESCE(payment_status, '')     NOT IN ($5, $6)       -- expired, failed
AND status NOT IN (<terminal statuses>)
```

Marking the internal status success makes it terminal and permanently closes the
fulfillment-retry path. `payment_status = paid` passes all three conditions, so a
retried webhook can still re-claim a `failed` fulfillment and finish the grant.

## Tests (red before green)

Add to `internal/core/services/paymentsvc/stripe_status_test.go`, following the
existing `paService` / `paPackageRepo` fake pattern already used by
`TestStripeWebhook_ProcessingPaidFailedExpiredAndReplay`:

1. **Paid event + package load failure** → assert `payment_status == "paid"` and
   `fulfillment_status == "failed"`. Must fail on current source.
2. **Retry after a failed fulfillment** → a second paid webhook re-claims and
   completes; assert `fulfillment_status` reaches `"fulfilled"`, granted amounts
   are exact, and the reward repository ran once more (not twice for the first
   attempt).
3. **Late failure/expiry cannot regress** → after fix 1, assert
   `models.CanApplyStripeFailureOrExpiry` is false so a subsequent
   `checkout.session.expired` cannot stamp `expired` on the captured payment.

Do not weaken or delete any existing assertion.

## Scope

| Repository | Work |
| --- | --- |
| `Games-Labs-Wallet` | The fix and its tests. Branch from current `origin/staging`, PR targets `staging`. |

### Out of scope

- Any change to the published `paymentpb` contract — the status vocabulary
  already covers this state; no proto or shared-lib change is needed.
- `api-gateway` — no route or dependency change.
- The Android client repository — read-only for all AI agents.
- Backfilling historical rows already stuck in the bad state. If any exist on
  staging, report them as findings; a data fix is a separate decision.
- The non-blocking TASK-EAR-278 suggestions (redundant reassignment at
  `stripe_callback.go:119`, historical `cancelled` → `failed` backfill mapping).
  Fold them in only if they cost nothing.

## Acceptance criteria

1. After a signed paid event whose fulfillment fails, the row reports
   `payment_status = "paid"` and `fulfillment_status = "failed"`.
2. The internal `status` is **not** moved to `success`, and a retried paid
   webhook can still re-claim and complete fulfillment.
3. A later failure or expiry event cannot move that row to `expired` or
   `failed`.
4. Rewards are still granted exactly once across the failure-then-retry
   sequence.
5. Every new test was seen failing before the fix.
6. Existing TASK-EAR-278 behavior is unchanged: ownership isolation, the
   pending/processing/paid/expired transitions, terminal precedence, and
   create-response compatibility.
7. Full Wallet tests, vet, readonly build, and `git diff --check` pass.

## Verification commands

```bash
# Games-Labs-Wallet
GOWORK=off go test ./internal/core/services/paymentsvc/ -run TestStripeWebhook -v
GOWORK=off go test ./...
GOWORK=off go vet ./...
GOWORK=off go build -mod=readonly ./...
git diff --check
```

Record the red run before the fix and the green run after it as separate
evidence. A green build is not acceptance.

## Provenance

Found during the TASK-EAR-278 cross-repo review of Wallet PR #25. The review was
posted at 11:00:22Z but the PR merged at 10:53:35Z, so the finding could not be
acted on before merge and shipped to staging in `24dba955`. Review comment:
https://github.com/SparqLab/Games-Labs-Wallet/pull/25#issuecomment-5327229678

Reward correctness was separately verified as safe during that review:
`applyTransactionInTx` checks `(user_id, idempotency_key)` inside a
`SELECT ... FOR UPDATE` on the wallet row, so concurrent or replayed deliveries
cannot double-credit. This task does not change that guarantee.

## Next action

Branch from current `origin/staging`, write the three failing tests first, apply
the one-field fix, then open a PR targeting `staging`.

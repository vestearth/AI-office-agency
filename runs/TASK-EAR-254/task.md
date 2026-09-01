# TASK-EAR-254 — `is_demo` grants package rewards without payment (Wallet)

## Origin

Multica issue SPAR-24 — QA: grant `ORDER_MANAGEMENT` for the named demo-purchase
account. This is the remaining operator-side prerequisite recorded by this run; it
does not authorize changing the account role or creating a broader access grant.

**Priority:** critical · **Service:** Games-Labs-Wallet (+ api-gateway surface)
**Exposure:** staging only — absent from `origin/main` and `origin/prod`
**Class:** same as TASK-EAR-191 (Missions) and TASK-EAR-180/182 (Order) —
a client-controlled field on a money path that the server trusts.

## The hole

`POST /api/v1/transaction` is a normal player-token route: the gateway
registers `PaymentService` (`api-gateway/gateway/grpc.go:92`). Its request
message carries a client-settable `is_demo` boolean
(`shared-lib/proto/paymentpb/payment.proto`, `CreateTransactionRequest`
field 13).

A request of roughly this shape, from any logged-in player, grants the
package's coin/diamond rewards with no payment at all:

```json
{
  "provider": "stripe",
  "type": "deposit",
  "is_demo": true,
  "order_package_id": "<any active purchase package>",
  "idempotency_id": "<unique>"
}
```

Trace (Games-Labs-Wallet unless noted):

| Step | Location | What happens |
|---|---|---|
| 1 | `internal/core/handlers/paymenthdl/grpc.go:98-106` | `resolveIsDemo` returns `req.GetIsDemo()` — straight from the body, no guard |
| 2 | `internal/core/services/paymentsvc/service.go:134` | `if in.IsDemo { return s.createStripeDemoDeposit(ctx, in) }` — skips checkout entirely (`:120` is the Ubit twin) |
| 3 | `internal/core/services/paymentsvc/stripe_deposit.go:134` | `ppr.CreatePaymentWithPackageRewards(...)` with payMethod `"stripe_demo"` |
| 4 | `internal/repositories/package_purchase_tx.go:39` | `applyPackageRewardsInTx` |
| 5 | `internal/repositories/package_purchase_tx.go:107-116` | `TxCredit` of `pkg.Coin` (and diamonds) into the wallet |

**No gate exists.** An exhaustive grep for `IsDemo` / `is_demo` / `DEMO`
across the repo's Go source, `config/config.go` and `ecs/env.names` finds
only the plumbing above — no env flag, no staff check, no demo-mode
config.

The HTTP twin has the same hole: `paymenthdl/http.go:93` via
`resolveHTTPDemo`, which accepts both `is_demo` and `isDemo`
(`http.go:122`).

## Second defect, same endpoint

`paymenthdl/grpc.go:46-51`:

```go
func resolveUserID(ctx context.Context, req *paymentpb.CreateTransactionRequest) string {
	if uid := strings.TrimSpace(req.GetUserId()); uid != "" {
		return uid          // body wins
	}
	return metadataFirst(ctx, "userid", "user-id", "x-user-id", "grpcgateway-userid")
}
```

Identity on a money path must come from gateway-set metadata only, never
the request body — the established rule from TASK-EAR-180/182. As written,
a caller can attribute a transaction to another user; combined with
`is_demo`, that means crediting someone else's wallet for free.

`resolveOrderPackageID` (`:53-58`) has the same body-first shape but is not
an identity field — leave it unless the fix makes it natural to align.

## What to do

1. **Reproduce first.** This was found by reading source, not by executing
   it. Confirm the exploit against staging (or a local run) before fixing,
   and capture the evidence — TASK-EAR-191's provenance note explains why
   execution beats analysis here.
2. **Regression test seen RED first**, then the fix. Do not weaken or skip
   any existing test to get green.
3. **Decide and write down** whether a demo/test purchase path should exist
   at all. If it must: gate it behind an env flag that is off in every
   shared environment *and* a staff check — never a request field.
   ⚠️ The operator's testers currently rely on shortcut payment paths, so
   removing this outright may strand QA. **Ask before deleting**; a
   sanctioned staff-gated replacement may be the right answer.
4. **Fix `resolveUserID`** to read identity from metadata only, fail-closed.
5. Cover **both** the Stripe and Ubit demo branches and **both** the gRPC
   and HTTP handlers.

## Scope notes

- Must be closed before the Stripe work is promoted to prod, or it ships
  with it. Not an emergency prod patch today (prod does not have it).
- Related: TASK-EAR-191 (Missions store-payment webhook, containment
  merged pending), TASK-EAR-180/182 (Order caller-identity sweep).
- Worth considering separately: a deliberate cross-service sweep of every
  money path. Three services have now shown this same class, each found by
  accident rather than by a sweep.

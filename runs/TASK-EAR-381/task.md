# TASK-EAR-381 — Split a purchase's discount into package and coupon shares

## Problem

`store.purchase.settled` from Order carries one discount line holding the
purchase's **whole** discount — the package's own discount and the coupon's
together:

```go
return []events.PlayerActivityDiscountLine{{Type: discountType, Amount: totalDiscount}}
```

So a 10% coupon on a package already 10% off reads as 19% everywhere the
monitoring pages look at it (TASK-EAR-378 promotion drill-down).

## The data already exists

Order persists the coupon's own discount, after its cap, on every order:
`orders.discount_amount_minor_units` + `discount_currency`, exposed on the
admin order proto. Verified on admin-dev 2026-09-23:

| order | original | paid | total discount | coupon (minor units) | package |
|---|---|---|---|---|---|
| TEST112 `78a82c2a` | 49.00 | 39.69 | 9.31 | 441 → 4.41 | 4.90 |
| 112233 `e7c179d2` | 29.00 | 26.10 | 2.90 | 290 → 2.90 | 0.00 |

## Plan

1. **Order, forward** — `storePurchaseDiscountLines` emits
   `{type: "package", amount: total − coupon}` when the package itself
   discounted, and `{type: <coupon type>, amount: coupon share}` when a coupon
   applied. The coupon share is the order's own
   `discount_amount_minor_units`, never re-derived.
2. **Order, backfill** — one-off subcommand
   `backfill-discount-split --before <ts> [--apply]`, dry-run by default, run
   as an ECS task like TASK-EAR-351. It emits a **new** event type,
   `store.purchase.discount_split`, per past settled coupon order, keyed by the
   order id.
3. **Logs** — project the correction event; the promotion drill-down prefers
   split lines (from the purchase itself, else from its correction) and
   publishes the coupon's real share as `offer`.
4. **Backoffice** — the promotion detail Offer column switches from the
   coupon's current terms to the purchase's real coupon share.

## Why not replay `store.purchase.settled`

Logs dedupes by event id twice — Postgres admission `ON CONFLICT (event_id)`
and ClickHouse `HasProjectedEvent` — and the purchase event id is
deterministic per order. A replay with the same id is dropped and changes
nothing. A replay with a *new* id would be a second purchase and double every
package purchase count. A distinct correction type is the only shape that
lands without touching the purchase aggregates; the gameplay outcome
correction set the same precedent.

## Acceptance

- New purchases carry split lines; the package report's measures are
  unchanged (lines are presentation, not aggregation inputs).
- The backfill is dry-run by default, idempotent (a second apply inserts
  nothing), and never touches Wallet.
- The promotion detail page shows 10% for TEST112 on Package I, not 19%.
- Prod is out of scope until the operator approves a supervised run.

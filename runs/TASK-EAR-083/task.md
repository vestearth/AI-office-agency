# TASK-EAR-083: Store > Exchange custom-amount endpoint

## Short Name

`store-exchange-custom-amount`

## Type

feature

## Priority

medium

## Status

Assigned to Dev on 2026-07-07 (opened via Claude advisory lane after a Mobile
team question).

## Background

Mobile's Store > Exchange tab has a **Custom Amount** input: the user types a
diamond quantity and exchanges at the base rate (1 Diamond = 10 Coins). Mobile
currently:

1. reads rates from `GET /api/v1/store/rates`, and
2. for the fixed tiers (Exchange 5 / 25 / 100 Diamonds) `POST`s to
   `/api/v1/store/exchange` with a `rate_id`.

The admin page `admin/manage/store/exchange` has a dedicated row **"Rate for
Player Custom" (1 → 10)** above the fixed tiers. That row is returned by
`GET /api/v1/store/rates` so the FE can display and preview the per-unit rate.

**The gap:** `POST /api/v1/store/exchange` accepts only `rate_id` and applies
the rate row's **fixed** `Diamonds`/`Coin` values — see
`Games-Labs-Missions/internal/services/store_service.go` `CreateExchange`
(~L456-518). There is **no** field for a user-supplied quantity and **no**
`custom` handling anywhere in the store service. Sending the custom row's
`rate_id` to the existing endpoint would exchange exactly 1 Diamond → 10 Coins
every time, silently ignoring the amount the user typed.

The base rate and its bounds already exist in the Wallet **RateCatalog**
(`Games-Labs-Wallet/internal/models/rate_catalog.go`), which carries
`Numerator`/`Denominator`, `RoundingMode`, and `MinValue`/`MaxValue`. So admin
already owns the rate + limits; only a backend endpoint that accepts a quantity
is missing.

## Decision

**Add a new endpoint** rather than extend `POST /api/v1/store/exchange`.

Rationale: the tier path is keyed on `rate_id`, routes through the Orders
catalog (`CreateExchangeOrder(userID, rateID, key)`), and builds its
idempotency key as `exchange:{userID}:{rateID}`. A custom quantity has no
catalog row and a different idempotency shape, so overloading the existing
handler would fork its logic and risk regression to the three live tiers. Both
paths still read from the same admin-owned RateCatalog, so admin control stays
in one place.

## Proposed Contract

### Request

```
POST /api/v1/store/exchange/custom
Content-Type: application/json
Idempotency-Key: <optional, also accepted in body>

{
  "user_id": "usr_123",
  "diamonds": 50,
  "idempotency_key": "optional-client-key"
}
```

- `diamonds` (int64, required): quantity the user typed. Must be > 0.

### Response (success, 200)

```
{
  "status": "credited",
  "spent_diamonds": 50,
  "credited_coin": 500,
  "rate": { "diamonds": 1, "coin": 10 }
}
```

Mirror the existing `models.ExchangeResult` shape used by
`POST /store/exchange` so the FE can reuse its result handling. Include the
applied per-unit rate for display/audit.

### Errors

| Case | Suggested code | Notes |
| --- | --- | --- |
| `diamonds <= 0` or missing | 400 | reuse `ErrInvalidInput` mapping |
| below `MinValue` / above `MaxValue` | 400/422 | new bounded error; message states the min/max |
| custom rate row inactive/missing | 409/404 | reuse `ErrRateInactive` / `ErrRateNotFound` |
| insufficient diamond balance | as existing | reuse wallet debit error mapping |
| duplicate idempotency key | idempotent success | reuse `ErrAlreadyClaimed` path |

## Computation

```
coin_out = round( diamonds * Numerator / Denominator , RoundingMode )
```

- Read the custom rate via the existing Wallet path
  `s.wallet.GetActiveRateByKey(ctx, "exchange.custom")` (confirm the exact
  `rate_key` used by the "Rate for Player Custom" row — verify against the
  seeded/admin value before coding; it may be `exchange.custom`,
  `exchange.base`, or a code Dev must read from the row).
- Apply `RoundingMode` from the catalog row (do not hardcode floor/round).
- Validate `MinValue`/`MaxValue` (nullable — skip the bound when nil).
- Debit diamonds / credit coins by **reusing** the existing
  `CreateExchange` debit→credit sequence (`models.DebitRequest` /
  `CreditRequest`, `Reason: "exchange_diamonds"`), with idempotency keys
  `{key}:debit` / `{key}:credit`. Idempotency key fallback:
  `exchange_custom:{userID}:{diamonds}` (distinct from the tier prefix).
- Record `PurchaseHistory` with `ItemType: "exchange"` as the tier path does.

## Scope

### Target Services

| Service | Reason |
| --- | --- |
| `Games-Labs-Missions` | Owns the store HTTP handlers, route table, and `StoreService.CreateExchange`; adds the new handler + service method. |
| `Games-Labs-Wallet` | Source of the custom rate row (RateCatalog `MinValue`/`MaxValue`/`RoundingMode`); confirm the row exists and `rate_key`. No code change expected if the row is already seeded/admin-set. |
| `Games-Labs-backoffice` | Confirm `admin/manage/store/exchange` exposes Min/Max/Rounding for the custom row; add fields if the form does not yet edit them. |
| `Games-Labs-Missions` (mobile FE consumer) | Mobile team repoints Custom Amount to the new endpoint (handled by Mobile, tracked here for contract). |
| `ai-dev-office` | Tracks this cross-repo work and verification. |

### Affected Files (backend, expected)

| Path | Action | Description |
| --- | --- | --- |
| `Games-Labs-Missions/internal/routes/apiv1.go` | modify | Register `POST /api/v1/store/exchange/custom`. |
| `Games-Labs-Missions/internal/handlers/mission/http/store.go` | modify | Add `ExchangeCustom` handler (decode `{user_id, diamonds, idempotency_key}`). |
| `Games-Labs-Missions/internal/services/store_service.go` | modify | Add `CreateCustomExchange(ctx, userID, diamonds, key)`; factor shared debit/credit out of `CreateExchange`. |
| `Games-Labs-Missions/internal/services/store_service_test.go` | modify | Cover rate lookup, rounding, min/max bounds, idempotency, insufficient balance. |
| `Games-Labs-Missions/internal/handlers/mission/http/store_test.go` | modify | Cover handler validation + happy path. |

## Acceptance Criteria

- `POST /api/v1/store/exchange/custom` accepts `{user_id, diamonds}` and
  exchanges the **actual** quantity, not a fixed 1→10.
- `coin_out` = `diamonds × Numerator/Denominator` with the row's `RoundingMode`.
- Requests below `MinValue` or above `MaxValue` are rejected with a clear
  min/max message; nil bounds are skipped.
- Diamonds debited and coins credited via the existing wallet debit→credit
  flow, idempotent under a custom-scoped key; duplicate replays return the
  idempotent-success shape.
- Existing `POST /store/exchange` tier behavior is unchanged (no regression to
  Exchange 5 / 25 / 100).
- The exact custom `rate_key` is confirmed against the "Rate for Player Custom"
  row before coding.
- Backoffice `admin/manage/store/exchange` can edit Min/Max/Rounding for the
  custom row (verify; add form fields if missing).
- Focused backend tests pass plus `go build ./...` for touched services.

## Risks

- **Rate-key mismatch:** the custom row's `rate_key`/`code` must be confirmed;
  guessing `exchange.custom` could read the wrong or a missing row. Verify
  first.
- **Rounding/precision:** integer coin output must follow the catalog
  `RoundingMode`; do not silently floor.
- **Bounds absent:** if the admin form does not yet persist Min/Max, custom
  exchange is unbounded — treat missing bounds as a product decision, surface
  it, don't invent a default silently.
- **Regression:** keep `CreateExchange` (tier path) untouched behaviorally when
  extracting shared debit/credit helpers.

## Verification Plan

- `ruby ai-dev-office/validate-yaml.rb TASK-EAR-083`
- Backend focused tests for `store_service` (rounding, bounds, idempotency) and
  the new handler.
- `go build ./...` for `Games-Labs-Missions`.
- Manual/contract check: confirm `GET /api/v1/store/rates` already returns the
  custom row and confirm its `rate_key` in the Wallet RateCatalog.
- Confirm Backoffice custom-row edit exposes Min/Max/Rounding.

## Open Questions for PM/Product

1. Should custom exchange carry a `BonusPercent` (the tier `ex_100` gives +10%)?
   Assumed **no** for v1 — pure per-unit rate.
2. Min/Max values for the custom row — what are the intended bounds? Needed
   before enabling unbounded exchange.
3. Is the base rate always 1:10, or can admin change the custom row's
   Numerator/Denominator freely (FE must always read the live rate, never
   hardcode 10)?

---

## Round 2 — Option A rework (Orders-backed custom exchange)

### Why (adversarial review, verified)

`USE_ORDERS_CATALOG="true"` in **staging** (`.github/workflows/staging.yml:100`)
and **prod** (`.github/workflows/prod.yml:97`); local `.env.example=false`. So
in every deployed env the tier path `CreateExchange` delegates to
`orderClient.CreateExchangeOrder` — Orders owns order lifecycle, audit,
fulfillment, and idempotency (`order:<orderID>`). Round 1's
`CreateCustomExchange` skipped the `useOrdersCatalog` check and moved currency
directly Missions→Wallet, so it was the only store money path bypassing Orders
(finding 1), and it reserved idempotency before debit/credit (finding 2) — a
strand risk the tier path avoids in orders-catalog mode by returning before
`markStoreIdempotency`. Routing custom through Orders resolves both.

### Design tension

Orders `CreateExchangeOrder` (`Games-Labs-Order/internal/core/services/ordersvc/service.go:160`)
is **package-based**: it loads a fixed exchange package and uses
`pkg.PriceDiamonds` + `calculatePackageCoinReward`. The "Rate for Player Custom"
row is an exchange package (code_name `custom`) with a fixed PriceDiamonds (1) →
passing its package_id as-is would still exchange only 1→10. Orders must accept
a **dynamic diamond amount override** and price it from the `exchange.custom`
rate (Orders already reads `exchange.<code_name>` at service.go:336).

### Scope (cross-repo)

**Games-Labs-Order** (added to scope):
| Path | Action | Description |
| --- | --- | --- |
| `internal/models/order.go` | modify | Add an optional `DiamondAmount` (custom quantity) to `CreateExchangeOrderRequest`, or add a dedicated `CreateCustomExchangeOrderRequest`. |
| `internal/core/services/ordersvc/service.go` | modify | When a custom amount is provided: validate the package is the custom exchange package, read the `exchange.custom` rate (Numerator/Denominator/RoundingMode/Min/Max via the wallet adapter, same source as service.go:336), compute `coin = amount × Num/Denom` with rounding, enforce Min/Max, and drive the Order + `ExchangeDiamondsToCoins` with the custom `amount` instead of `pkg.PriceDiamonds`. Keep the fixed-package path unchanged. |
| gRPC/HTTP surface + generated stubs | modify | Expose the custom amount on whatever transport Missions' order client calls (mirror the existing exchange-order call; check proto/grpc-gateway if applicable). |
| order service tests | modify | Custom amount pricing, rounding, Min/Max, idempotency, package-not-custom rejection, fixed-package path unchanged. |

**Games-Labs-Missions**:
| Path | Action | Description |
| --- | --- | --- |
| `internal/services/store_service.go` | modify | `CreateCustomExchange`: `if useOrdersCatalog && orderClient != nil` → delegate to the new Orders custom-exchange call (Orders owns idempotency); else keep the round-1 legacy direct-wallet path. Remove the reserve-before-debit strand from the delegated path (Orders handles it). |
| `internal/clients/order/client.go` | modify | Add the client method for the Orders custom-exchange call. |
| `internal/services/store_service_test.go` | modify | orders-catalog mode delegates to Orders; legacy mode direct-wallet; tier path still unchanged. |

### Round 2 acceptance criteria

- With `USE_ORDERS_CATALOG=true`, `POST /api/v1/store/exchange/custom` creates an
  Orders order for the exact custom amount and moves currency via the Orders
  exchange flow — no direct Missions→Wallet debit/credit on this path.
- Coin computed from the `exchange.custom` rate (Num/Denom + RoundingMode),
  Min/Max enforced, `diamonds<=0` rejected.
- Idempotency owned by Orders on the delegated path; a transient wallet failure
  does not strand the exchange as permanently already-claimed (add
  debit-fail / credit-fail-after-debit retry tests).
- Fixed-package tier exchange behavior unchanged in both Orders and Order code.
- Legacy direct-wallet path (`USE_ORDERS_CATALOG=false`) still works for local.
- `go build ./...` + focused tests pass in **both** repos; branches:
  Missions `feature/TASK-EAR-083-store-exchange-custom-amount` (continue),
  Order `feature/TASK-EAR-083-store-exchange-custom-amount` (cut from staging).
- `ruby ai-dev-office/validate-yaml.rb TASK-EAR-083` passes.

### Round 2 risks

- Cross-repo contract drift: the Missions order client and the Order service
  custom-amount field must match; if a proto/grpc-gateway binding is involved,
  regenerate and verify the wire field is not dropped (prior `_1`-suffix /
  DiscardUnknown gotchas).
- Do not fork the fixed-package Orders path; branch on custom-amount presence.
- Confirm the custom exchange package exists/synced (code_name `custom`) in the
  Order catalog for the target env; unconfigured → clear not-found, no silent
  fallback.

---

## Round 3 — hardening (F3 overflow + F5 authoritative amount)

Second adversarial review (both repos) confirmed F1/F2 closed. Two in-scope
highs remain; F4 is spun off (separate ticket — pre-existing Orders idempotency
recovery, affects tier exchange too).

### F3 — checked arithmetic + hard max (Order, and mirror in Missions legacy)

`Games-Labs-Order/internal/core/services/ordersvc/service.go` `applyExchangeRateRounding`
does `prod := diamonds * numerator` with no overflow guard. When the
`exchange.custom` rate has `MaxValue == nil`, the HTTP-controlled
`diamond_amount` is unbounded, so `diamonds * numerator` can overflow int64
(and the ceil/nearest `+` can overflow too), producing a wrong/negative coin
amount while Orders still asks Wallet to debit the huge diamond amount.

- Reject `amount` that would overflow: `amount > (math.MaxInt64 - denominator) / numerator` (guard before multiply); guard the ceil/nearest addition too.
- Enforce a **hard service-side maximum** even when `rate.MaxValue` is nil (pick a sane cap; document it). Do not rely solely on admin-configured Min/Max.
- The same unguarded multiply exists in the Missions legacy path (`applyRateRounding`) — mirror the guard there.
- Tests: overflow-edge inputs (near MaxInt64), nil-MaxValue cap, ceil/nearest overflow.

### F5 — Orders response is the source of truth for moved amounts

`Games-Labs-Missions/internal/services/store_service.go` `CreateCustomExchange`
delegates to Orders but **ignores the returned order** (`if _, err := ...`) and
then records `GotCoin: coinOut` (locally computed) with `PayMethod: order_service`
and returns `CreditedCoin: coinOut`. If the rate changes between the Missions
read and Orders fulfillment (or Orders applies different rounding/bounds/rate
version), the API response and Missions history report an amount Orders did not
actually move.

- Extend the Orders exchange response/model to return the **actual** fulfilled
  amounts: spent diamonds, credited coin, applied rate (and rate version if
  available), and order id. Surface them through `POST /api/v1/orders/exchange`
  and the Missions order client `CreateCustomExchangeOrder` return.
- In Missions, build the HTTP result and `PurchaseHistory` from the **Orders
  response**, not the local `coinOut`. Keep the local read only as a
  pre-flight/preview if useful, never as the recorded/returned truth.
- Test: Missions reads one `exchange.custom` rate but Orders returns a fulfilled
  order priced differently → Missions returns/persists the Orders amount, not
  the stale local one.

### Round 3 acceptance criteria

- No int64 overflow reachable from `diamond_amount` in either repo; a hard cap
  applies even with nil `MaxValue`; overflow tests pass.
- Missions custom-exchange response + history reflect the amount Orders actually
  fulfilled; drift test passes.
- F1/F2 stay closed; fixed-package/tier exchange behavior unchanged.
- `go build ./...` + focused tests pass in both repos; commits on the existing
  `feature/TASK-EAR-083-store-exchange-custom-amount` branches (not staging).
- `ruby ai-dev-office/validate-yaml.rb TASK-EAR-083` passes.

### Out of scope (tracked separately)

- **F4** — Orders `CreateExchangeOrder` returns an existing failed order for the
  client idempotency_key before replaying `order:<orderID>`, so a partial wallet
  failure cannot recover on retry. Pre-existing, affects tier exchange equally.
  Spun off to its own TASK-EAR ticket.

---

## Round 4 — close idempotent-replay authoritative amount (fail-safe, no migration)

Both round-3 adversarial passes (Order + Missions) independently flagged the
same and only remaining issue. F1/F2/F3 and the main F5 path are confirmed
closed.

### The bug (verified)

On a duplicate retry with the same idempotency key of an **already-fulfilled**
custom exchange:
- Order `CreateExchangeOrder` early-returns the existing order with
  `CreditedCoin=0, Rate=nil` (it does not re-price) —
  `Games-Labs-Order/.../ordersvc/service.go` ~L179-186.
- Missions `CreateCustomExchange` initializes `creditedCoin` from the local
  Wallet-rate **preview** and only overwrites it when `ordersRes.CreditedCoin > 0`
  — `Games-Labs-Missions/.../store_service.go` ~L709-730. So when Orders returns
  0, Missions records/returns the **preview** amount. If the `exchange.custom`
  rate changed between the original fulfillment and the replay, that preview
  (e.g. 500) differs from what Orders actually moved (e.g. 480) → the API
  response and a newly-appended `PurchaseHistory` row report a wrong "success".

The Order record does not persist the moved coin as a column (`Amount` =
diamonds only), and a custom coin is `amount × live rate`, so it cannot be
re-derived authoritatively on replay without persistence.

### Fix — fail-safe (preferred; no DB migration)

Do **not** fabricate an amount on replay.

- **Missions** (`CreateCustomExchange`, delegated/orders-catalog branch): when
  the Orders response does not carry an authoritative credited amount (replay /
  `credited_coin == 0`), return an **`already_claimed`** result (idempotent) —
  do **not** write a new success `PurchaseHistory` row using the local preview,
  and do **not** return a preview `credited_coin`. Report the known
  `SpentDiamonds`; leave credited coin unset/zero **with `already_claimed`
  status** (honest "duplicate, amount not re-derived here"), never a
  success-looking fabricated number. Ensure a replay does not append a second or
  incorrect history row (the first fulfillment's response already reported the
  true amount).
- **Order**: make the replay result explicitly signal amounts-unavailable rather
  than a silent authoritative-looking `0` — e.g. a boolean/`Replayed` flag or
  leaving credited/rate as clearly-unset that the client treats as
  already_claimed. Do not touch the F4 recovery behavior (TASK-EAR-084).

Only persist-and-load the original credited coin/rate if it is genuinely cheap
(no new migration). A DB migration to store the coin is out of scope for round 4
— the fail-safe already removes the ability to record/return a wrong amount.

### Round 4 acceptance criteria

- A successful custom exchange followed by a same-idempotency-key replay, with
  the `exchange.custom` rate changed in between, does **not** return or persist
  the local preview amount. Missions returns `already_claimed` and writes no
  new/incorrect success history row.
- Normal (first) fulfillment still reports the Orders-authoritative amount
  (round-3 behavior unchanged).
- F1/F2/F3 stay closed; tier/fixed-package path unchanged; F4 untouched.
- `go build ./...` + focused tests pass in both repos; commits on the existing
  feature branches (not staging).
- New test: Orders-mode replay where first fulfillment amount ≠ current preview
  and Orders returns `credited_coin=0` → assert Missions does not record/return
  the preview amount (returns already_claimed).
- `ruby ai-dev-office/validate-yaml.rb TASK-EAR-083` passes.

---

## Round 5 — replay-ordering high + integration test

Round-4 adversarial re-review left two findings.

### Missions [high] — delegate to Orders BEFORE the live-rate gate

`Games-Labs-Missions/internal/services/store_service.go` `CreateCustomExchange`
fetches and validates the live `exchange.custom` rate (numerator/denominator,
hard cap, MinValue, MaxValue, rounding) at ~L643-676 **before** the
`if s.useOrdersCatalog` branch. So a same-key replay of an already-fulfilled
order never reaches Orders when the rate was deleted, Wallet is degraded, or the
admin lowered `MaxValue` below the original diamond amount — the client gets
rate-not-found / invalid-request instead of `already_claimed` with the
authoritative `SpentDiamonds`. This defeats the round-4 replay guarantee under a
normal admin action.

Orders already validates and prices on the first call (`priceCustomExchange` in
`Games-Labs-Order/.../ordersvc/service.go` enforces amount>0, Min/Max, hard cap,
overflow), so the Missions pre-gate is **redundant** in orders-catalog mode.

Fix:
- In orders-catalog mode (`useOrdersCatalog && orderClient != nil`), do **not**
  fetch/validate the live Wallet rate first. Resolve the custom package and call
  `CreateCustomExchangeOrder` first; let Orders distinguish first fulfillment
  from replay and own validation/pricing. Only reject amount<=0 / empty user up
  front (cheap, transport-level).
- Keep the Wallet rate fetch + Min/Max/cap/rounding **only** in the legacy
  direct-wallet path (`USE_ORDERS_CATALOG=false`).
- On first fulfillment, build the response/history from the Orders-authoritative
  amounts (round-3 behavior). On replay, keep the round-4 fail-safe
  (already_claimed, only SpentDiamonds, no fabricated amount, no extra history).
- Do not regress F3 (the legacy path keeps its overflow guard + cap).

Test: orders-mode replay where the second request sees Wallet 404 **or**
`MaxValue` lowered below the original amount → assert `already_claimed`,
`credited_coin=0`, authoritative `SpentDiamonds`, no second history row.

### Order [medium] — fix the integration-tagged exchange test

`Games-Labs-Order/tests/integration/exchange_test.go` (build tag `integration`,
excluded from the default `go test ./...`) no longer compiles: it treats
`CreateExchangeOrder`'s return as `*models.Order` (it is now
`*models.ExchangeOrderResult`), and `integrationWallet` does not implement
`ports.WalletAdapter.GetActiveRateByKey`.

Fix:
- Add `GetActiveRateByKey` to the integration wallet stub.
- Unwrap `res.Order` in the exchange integration test; assert `res.Replayed`,
  `res.CreditedCoin`, and no extra wallet call on replay where applicable.
- Ensure `go test -tags integration ./tests/integration` at least compiles
  (run it; if it needs a live DB to execute, compiling + skipping runtime is
  acceptable — note which).

### Round 5 acceptance criteria

- Orders-mode custom exchange replay returns `already_claimed` with the
  authoritative `SpentDiamonds` even when the live `exchange.custom` rate is
  removed or its `MaxValue` is lowered below the original amount; no fabricated
  amount, no extra history row.
- First fulfillment still reports the Orders-authoritative amount; legacy path
  unchanged incl. its overflow guard/cap; F1/F2/F4 untouched.
- `go test -tags integration ./tests/integration` compiles (and passes, or is
  documented as needing a DB to run).
- `go build ./...` + focused/full unit suites pass in both repos; commits on the
  existing feature branches (not staging).
- `ruby ai-dev-office/validate-yaml.rb TASK-EAR-083` passes.

### Stop criterion

Merge-ready when the next adversarial review returns no `high` finding; any
remaining medium/low become follow-up tickets.

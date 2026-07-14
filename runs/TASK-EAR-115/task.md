# TASK-EAR-115: Restore-streak paid in Point must use the redeem path, not Debit

Type `bugfix`; workstream `backend`; priority `high`; owner `dev`.
Related `TASK-EAR-113` (option 1 unmasked this real cause). Operator decision: make Point work.

## Symptom (surfaced after TASK-EAR-113 option 1 shipped)

QA set the check-in Restore-Streak currency to **Point**; pressing restreak returns:

```json
{ "code": 3, "message": "{\"code\":1002,\"error\":\"wallet: currency must be coin or diamond\"}", "details": [] }
```

(`code 3` = INVALID_ARGUMENT; inner `code 1002` = the new typed client error from option 1
carrying the real Wallet reason — the masking is gone; this is the true cause.)

## Root cause

Restore streak is a **spend**, and it always calls `wallet.Debit(currency=quote.Currency)`
(`internal/services/check_in_calendar_service.go:607`). The Wallet `/wallets/debit`
endpoint only accepts coin/diamond (`wallet_handler.go:235`); **points cannot be spent via
Debit** — they must go through `/wallets/redeem` (`RedeemPoints`). Points and coin/diamond
are separate subsystems (`wallets.points` + `wallet_points_ledger` vs coin/diamond ledger);
Credit accepts POINT (earning works) but Debit does not (spending fails).

The restore currency is the only admin-configurable spend currency (tournament / store /
legacy restore hardcode diamond), so this only breaks when restore is configured as Point.

## Scope

- `Games-Labs-Missions/internal/services/check_in_calendar_service.go` — route the restore
  fee spend: currency POINT/POINTS → `wallet.RedeemPoints`; coin/diamond → `wallet.Debit`
  (unchanged). Extract a small testable helper.
- Focused unit test (DB-free) asserting the routing hits `/wallets/redeem` for Point and
  `/wallets/debit` for diamond, plus insufficient-points → typed `InsufficientPoints` (402).
- Missions-only: `/wallets/redeem` already exists and handles the points spend; no Wallet
  change needed.

## Acceptance criteria

- Restore with currency Point spends via `/wallets/redeem` and succeeds when points suffice.
- Insufficient points on a Point restore returns typed `InsufficientPoints` (402), not INVALID_ARGUMENT.
- Restore with coin/diamond still uses `/wallets/debit` (unchanged); the restore ledger
  rollback on failure is preserved.
- `go build ./...` and the focused test pass.

## Plan

1. Add `restoreStreakSpend(ctx, wallet, userID, currency, amount, refDate, idempKey)` that
   routes POINT → RedeemPoints, else → Debit.
2. Call it from `RestoreStreakWithResult` in place of the direct Debit.
3. Add a DB-free unit test via an httptest Wallet server (path assertions + 402 mapping).
4. Verify build + focused tests; open a Missions PR against staging.

## Risks

- Spending "points" debits the level/EXP points balance (per Wallet: points are the
  level/EXP source of truth). This is the intended meaning of a Point restore fee; product
  should be aware. Mitigation: routing only — no change to point semantics.
- Idempotency: RedeemPoints reuses the restore ledger idempotency key (non-empty), matching
  the previous Debit call; redeem has its own idempotency scope.

## Source evidence

- `internal/services/check_in_calendar_service.go:606-622` (restore Debit), `:594,610` (quote.Currency)
- `Games-Labs-Wallet/.../wallet_handler.go:235` (Debit coin/diamond only), `:165` (Credit allows point)
- Wallet service Credit POINT -> repo.CreditPoints (wallets.points); RedeemPoints -> repo.DeductPoints (same balance)
- `internal/clients/wallet/client.go:199` RedeemPoints (POST /wallets/redeem)

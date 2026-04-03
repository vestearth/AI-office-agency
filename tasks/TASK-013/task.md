# TASK-013: Spendable Points — shared-lib Proto + Wallet Service Foundation

## Epic
Points Redemption System (Spendable Points to External Rewards)

## Type
feature

## Priority
high

## Depends On
None — this is Subtask 1. TASK-014 is blocked until this is approved.

## Target Services
- `shared-lib` — proto definitions
- `Games-Labs-Wallet` — accumulation logic, redemption RPC, DB schema

---

## Overview
Introduce the **Spendable Points** balance into the platform.

Points are earned passively whenever coin turnover occurs (1 Point per 5,000
coins debited/bet) and stored in `wallets.points`. They can be redeemed by the
Order service via a safe, idempotent gRPC call that **only deducts points** —
no in-game item or coin reward is granted by the Wallet layer.

This task builds the foundation. TASK-014 (Order service) consumes the new
`RedeemPoints` RPC and enforces the level gate.

---

## Business Rules
- **Earn rate**: 1 Spendable Point per 5,000 `coin_turnover` (DEBIT + BET
  transactions). Use integer division; partial increments are not awarded until
  the next full 5,000.
- **Accumulation**: Points are additive; they never expire unless redeemed.
- **Redemption**: The Wallet only deducts points atomically. It does **not**
  credit any in-game currency. Level eligibility is NOT checked here.
- **Idempotency**: `RedeemPoints` must be safe to retry using an
  `idempotency_key`. Double-deduction must be impossible at the DB level.
- **Insufficient balance**: Return a clear error (`ErrInsufficientPoints`) when
  `points < requested_amount`.

---

## Current State (from code audit)
- `wallets.points` column already exists in the DB and in `models.Wallet`.
- `AwardPoints` and `RedeemPoints` exist in `ports.WalletService` and the HTTP
  handler scaffold (`POST /wallets/redeem`), but both return
  `errors.New("not implemented: points support not added yet")`.
- `coin_turnover` is already accumulated in `wallet.go` inside `ApplyTransaction`
  on DEBIT/BET transactions (line ~206-209). The points award hook belongs in
  the same block.
- `walletpb/wallet.proto` has no `RedeemPoints` RPC and no points-related
  messages yet.

---

## Objectives

### 1. shared-lib: `walletpb/wallet.proto`
Add a new `RedeemPoints` RPC and its messages:

```proto
rpc RedeemPoints(RedeemPointsRequest) returns (RedeemPointsResponse) {
  option (google.api.http) = {
    post: "/api/v1/wallet/redeem-points"
    body: "*"
  };
}

message RedeemPointsRequest {
  string user_id         = 1;
  int64  points          = 2;  // must be > 0
  string reason          = 3;  // e.g. "external_reward", free-form label
  string idempotency_key = 4;
}

message RedeemPointsResponse {
  basepb.StatusResponse status = 1;
  message Data {
    string user_id      = 1;
    int64  points_after = 2;
  }
  Data data = 2;
}
```

Regenerate all Go bindings (`*.pb.go`, `*.pb.gw.go`, `*.swagger.json`) and
publish a new `shared-lib` version.

### 2. Games-Labs-Wallet: Points accumulation hook
In `internal/repositories/wallet.go`, inside `ApplyTransaction`, in the same
block as the existing `coin_turnover` update (~line 206-209), add:

```sql
UPDATE wallets
   SET points = points + ($amount / 5000)
 WHERE user_id = $user_id
   AND ($amount / 5000) > 0
```

Where `$amount` is the coin amount being debited/bet. Define
`CoinsPerPoint = int64(5000)` as a named constant in `models/wallet.go` or
the service layer.

### 3. Games-Labs-Wallet: `AwardPoints` implementation
Implement `AwardPoints` in `walletsvc/service.go`:
- Validate `userID` non-empty, `points > 0`.
- Call a new repository method `AddPoints(ctx, userID string, delta int64) error`:
  `UPDATE wallets SET points = points + $1 WHERE user_id = $2`.
- No idempotency required (additive by design).

Add `AddPoints` to `ports.WalletRepository`.

### 4. Games-Labs-Wallet: `RedeemPoints` implementation
Implement `RedeemPoints` in `walletsvc/service.go`:
- Validate `userID`, `points > 0`, `idempotencyKey` non-empty.
- Call a new repository method
  `DeductPoints(ctx, userID string, delta int64, idempotencyKey string) (pointsAfter int64, err error)`:
  - Run inside a DB transaction.
  - Check `points >= delta`; return `ErrInsufficientPoints` if not.
  - Decrement `points` atomically.
  - Insert a row into `wallet_points_ledger` with `type = 'POINTS_REDEEM'` and
    the idempotency key. Handle the UNIQUE violation as an idempotent success
    (return the current balance).
- Add `DeductPoints` to `ports.WalletRepository`.
- Add `ErrInsufficientPoints` to `models/errors.go`.

**Important**: `RedeemPoints` only deducts points. It does NOT credit any
in-game currency. The Wallet has no knowledge of what the points are being
spent on.

### 5. Games-Labs-Wallet: gRPC handler
Implement `RedeemPoints` in `wallethdl/grpc.go` using the new proto messages.
- Return HTTP `409` / gRPC `FAILED_PRECONDITION` on `ErrInsufficientPoints`.

### 6. Games-Labs-Wallet: HTTP handler
Replace the scaffold in `wallethdl/wallet_handler.go` (`POST /wallets/redeem`)
with a real implementation that calls `ws.RedeemPoints`.
- Return `402 Payment Required` on `ErrInsufficientPoints`.

### 7. Games-Labs-Wallet: DB migration
Add a new migration file:

```sql
-- Ensure points column exists (guard for environments that may not have it)
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS points BIGINT NOT NULL DEFAULT 0;

-- Audit ledger for point changes
CREATE TABLE IF NOT EXISTS wallet_points_ledger (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL,
  delta           BIGINT      NOT NULL,      -- positive = award, negative = redeem
  type            VARCHAR(30) NOT NULL,      -- 'AWARD' | 'POINTS_REDEEM'
  reference_id    TEXT,
  idempotency_key TEXT        UNIQUE,        -- prevents double-spend at DB level
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wpl_user_id ON wallet_points_ledger (user_id);
```

---

## Acceptance Criteria
- [ ] `walletpb/wallet.proto` has `RedeemPoints` RPC with `POST /api/v1/wallet/redeem-points` annotation.
- [ ] Go bindings regenerated; `shared-lib` version bumped.
- [ ] Every DEBIT/BET coin transaction increments `wallets.points` by `floor(amount / 5000)` — verified by unit test.
- [ ] `AwardPoints` correctly increments the balance — covered by unit test.
- [ ] `RedeemPoints` atomically deducts points, is idempotent via `idempotency_key`, and returns `ErrInsufficientPoints` when balance is insufficient — covered by unit test.
- [ ] `RedeemPoints` does NOT credit any coin or diamond balance.
- [ ] gRPC `RedeemPoints` returns `409` / `FAILED_PRECONDITION` on insufficient points.
- [ ] HTTP `POST /wallets/redeem` returns `402` on insufficient points.
- [ ] DB migration creates `wallet_points_ledger` with `UNIQUE` idempotency_key constraint.
- [ ] `go build ./...` and `go test ./...` pass in `Games-Labs-Wallet`.

---

## Technical Notes
- **No level gate here.** Level enforcement belongs in the Order service (TASK-014).
- **No in-game reward here.** The Wallet only deducts points; it has no concept
  of what the redemption is for.
- The `coin_turnover` accumulation hook is at `wallet.go:206-209`. Add the
  points award in the **same transaction block** to keep it atomic.
- `CoinsPerPoint = 5000` must be a named constant, not a magic number.
- The `wallet_points_ledger.idempotency_key` UNIQUE constraint is the last line
  of defence against double-spend.

---

## Files to Create / Modify
| File | Action |
|------|--------|
| `shared-lib/proto/walletpb/wallet.proto` | modify |
| `shared-lib/proto/walletpb/wallet.pb.go` | regenerate |
| `shared-lib/proto/walletpb/wallet.pb.gw.go` | regenerate |
| `shared-lib/proto/walletpb/wallet.swagger.json` | regenerate |
| `Games-Labs-Wallet/internal/models/wallet.go` | add `CoinsPerPoint` constant |
| `Games-Labs-Wallet/internal/models/errors.go` | add `ErrInsufficientPoints` |
| `Games-Labs-Wallet/internal/core/ports/repositories.go` | add `AddPoints`, `DeductPoints` |
| `Games-Labs-Wallet/internal/repositories/wallet.go` | implement `AddPoints`, `DeductPoints`; hook points award into `ApplyTransaction` |
| `Games-Labs-Wallet/internal/core/services/walletsvc/service.go` | implement `AwardPoints`, `RedeemPoints` |
| `Games-Labs-Wallet/internal/core/handlers/wallethdl/grpc.go` | implement `RedeemPoints` gRPC handler |
| `Games-Labs-Wallet/internal/core/handlers/wallethdl/wallet_handler.go` | replace scaffold with real implementation |
| `Games-Labs-Wallet/migrations/<next>.sql` | create `wallet_points_ledger` migration |

## Assigned Agent
`dev-2`

# TASK-EAR-113: Restore-streak wallet error masked as INTERNAL (code 13 / 1000)

Type `bugfix`; workstream `backend`; priority `high`; owner `dev`.
Created via the Claude advisory (free-roam) lane using the `debugging` skill.
**Blocked on operator review — do not implement until explicit go-ahead.**

## Symptom

Pressing **restreak** (restore check-in streak) returns:

```json
{ "code": 13, "message": "{\"code\":1000,\"error\":\"wallet error: 400 Bad Request\",\"message\":\"wallet error: 400 Bad Request\"}", "details": [] }
```

`code 13` = gRPC INTERNAL; inner `code 1000` = generic InternalServer. The real
cause (a Wallet HTTP 400, almost certainly **insufficient diamond balance**) is
hidden, so the client shows an opaque internal error instead of "not enough
diamonds".

## Root cause (verified against source)

The restreak Debit succeeds field-validation (currency default `DIAMOND`, whole
integer price) so the only remaining 400 is a Wallet service error. That error
is swallowed by **two** layers:

1. **Wallet Debit handler hardcodes 400 for every service error.**
   `Games-Labs-Wallet/internal/core/handlers/wallethdl/wallet_handler.go:253-256`
   maps a typed `InsufficientDiamondBalance` (code 6014, which
   `shared-lib/errors/map.go` would map to HTTP 402) to a flat
   `http.StatusBadRequest` with body `{"error":"Insufficient diamond balance."}`.

2. **Missions wallet client discards the Wallet response body.**
   `Games-Labs-Missions/internal/clients/wallet/client.go:105-107` (Debit; same
   pattern at :138 Credit, :197 RedeemPoints, :255 GetActiveRateByKey) returns a
   bare `fmt.Errorf("wallet error: %s", rsp.Status)` = `"wallet error: 400 Bad
   Request"`, dropping the body. Being an untyped error it is mapped to code 1000
   (`shared-lib/errors/errormsg.go:209` InternalServerErr) → HTTP 500
   (`HTTPStatusFromError`) → api-gateway relays as gRPC code 13.

Path: `RestoreStreakWithResult`
(`Games-Labs-Missions/internal/services/check_in_calendar_service.go:606`) →
`wallet.Debit` (DIAMOND, `float64(quote.Price)`), default restore currency
`DIAMOND` at `check_in_calendar_service.go:45`, price ladder 5/7/10 at `:47-50`.

## Scope

- **Primary:** `Games-Labs-Missions/internal/clients/wallet/client.go` — on non-2xx,
  read the Wallet response body and map to typed `MetaError`s (insufficient →
  `InsufficientDiamondBalance` 6014 / `InsufficientFunds` 6002 /
  `InsufficientPoints` 6003; other 4xx → a typed client error carrying the Wallet
  reason). Apply to `Debit` and `Credit` at minimum; consider `RedeemPoints` /
  `GetActiveRateByKey` for consistency.
- **Secondary (recommended, operator to confirm during review):**
  `Games-Labs-Wallet/internal/core/handlers/wallethdl/wallet_handler.go` Credit/Debit
  handlers — replace the hardcoded `StatusBadRequest` with
  `errormsg.HTTPStatusFromError(err)` so `InsufficientDiamondBalance` surfaces as
  402/409, not 400.
- No behavior change to the happy path; no proto/contract change; error-mapping only.

## Acceptance criteria

- Restreak with insufficient diamonds returns a typed insufficient-balance error
  (HTTP 402/409, code 6014) with a human-readable message — NOT gRPC code 13 /
  code 1000 / "wallet error: 400 Bad Request".
- The Wallet 400 reason (e.g. `"Insufficient diamond balance."`) is preserved
  through the Missions wallet client rather than discarded.
- Genuinely malformed/other 4xx Wallet responses still surface a 4xx (client)
  error, not INTERNAL/500.
- Existing successful Debit/Credit flows are unchanged; focused unit tests cover
  insufficient-balance and generic-4xx mapping for the wallet client.
- `go test ./...` and readonly build pass in each touched repo.

## Plan (on approval)

1. In the Missions wallet client, extract a shared non-2xx handler: read body,
   detect insufficient-balance signal, map to the correct typed `MetaError`;
   fall back to a typed 4xx error carrying `rsp.Status` + trimmed body for other
   non-2xx. Wire into Debit and Credit (then Redeem/Rate).
2. Add focused wallet-client tests (insufficient → 6014/402; other 4xx → client
   error; 5xx → ServiceUnavailable as today).
3. (If approved) update Wallet Credit/Debit handlers to use
   `HTTPStatusFromError(err)` for the status code.
4. Verify end-to-end: restreak with insufficient diamonds shows the correct
   error; happy path still credits/debits.

## Risks

- Loosely matching the "insufficient" body string could mis-map other errors.
  Mitigation: prefer matching the Wallet typed message exactly / status 402 once
  the handler is fixed; keep a conservative fallback to a generic 4xx.
- Two-repo change ordering. Mitigation: the Missions-side fix alone already
  removes the INTERNAL masking; the Wallet-side status fix is additive.

## Verification plan (needed to pin the live instance)

- Confirm by checking the acting user's diamond balance vs the restore price for
  that restore number, OR the Wallet access log showing
  `POST /wallets/debit -> 400 {"error":"Insufficient diamond balance."}`.
- Secondary possibility if it is NOT insufficient balance: an admin-set check-in
  campaign `Restore.Currency` that is not coin/diamond (e.g. `POINT`), which the
  Debit handler rejects with `"currency must be coin or diamond"`.

## Source evidence

- `Games-Labs-Missions/internal/clients/wallet/client.go:106,138,197,255`
- `Games-Labs-Wallet/internal/core/handlers/wallethdl/wallet_handler.go:230-256`
- `Games-Labs-Wallet/internal/repositories/wallet.go:183,322` (InsufficientDiamondBalance)
- `Games-Labs-Missions/internal/services/check_in_calendar_service.go:45,47-50,606-615`
- `shared-lib/errors/map.go` (HTTPStatusFromError, ErrorPayload), `errormsg.go:209`

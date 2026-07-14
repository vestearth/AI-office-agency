# TASK-EAR-114: Wallet Credit/Debit handlers return semantic HTTP status (option 2)

Type `bugfix`; workstream `backend`; priority `medium`; owner `dev`.
Parent `TASK-EAR-113` (option 1 shipped: Missions wallet client typed-error mapping,
PR SparqLab/Games-Labs-Missions#68 merged to staging). Operator pre-approved option 2.

## Outcome

The Wallet HTTP `Credit`/`Debit` handlers currently map **every** service error to
a hardcoded `http.StatusBadRequest` (400)
(`Games-Labs-Wallet/internal/core/handlers/wallethdl/wallet_handler.go:187,255`),
collapsing typed `InsufficientDiamondBalance` (6014) / `InsufficientFunds` (6002)
into 400. Make them return the semantic status via shared-lib so insufficient
balance surfaces as **402 / 409** at source — consistent with the existing redeem
handler (`:497` already returns 402 for `InsufficientPoints`). This lets the
Missions client (option 1) rely on the HTTP status code instead of the
`"insufficient"` body-text heuristic.

## Scope

- `Games-Labs-Wallet/internal/core/handlers/wallethdl/wallet_handler.go` — Credit and
  Debit service-error branches only.
- Add a small helper `walletServiceHTTPStatus(err) int`: typed MetaErrors keep their
  shared-lib status (`errormsg.HTTPStatusFromError`); unrecognized (non-MetaError)
  errors stay `400` as today (no widening to 500).
- Focused handler tests (insufficient diamond → 402, insufficient coin → 409,
  unknown error → 400 unchanged).
- Do NOT touch input-validation `writeError(..., StatusBadRequest, ...)` calls
  (invalid JSON / bad currency / positive-amount) — only the post-service-call error.

## Acceptance criteria

- Debit/Credit with `InsufficientDiamondBalance` → HTTP 402; with `InsufficientFunds`
  → HTTP 409; the `{"error": ...}` reason body is preserved.
- Non-MetaError service errors still return 400 (behavior unchanged).
- Input-validation 400s (invalid JSON, bad currency, non-positive amount) unchanged.
- `go build ./...` and `go test ./...` pass; focused handler tests added.

## Plan

1. Add `walletServiceHTTPStatus` helper.
2. Swap the two hardcoded `http.StatusBadRequest` in the Credit/Debit service-error
   branches for `walletServiceHTTPStatus(err)`.
3. Add focused handler tests via a fake `ports.WalletService`.
4. Verify build + tests; open a Wallet PR against `staging`.

## Risks

- Contract change: Credit/Debit HTTP status for insufficient balance shifts 400 → 402/409.
  Blast radius: mainly the Missions client (already handles 402 after option 1) and any
  other `/wallets/{credit,debit}` caller. Mitigation: only insufficient-balance codes
  change; all other statuses (incl. validation 400s and non-typed errors) are preserved.

## Source evidence

- `Games-Labs-Wallet/internal/core/handlers/wallethdl/wallet_handler.go:183-189,253-257` (hardcoded 400)
- `wallet_handler.go:497-498` (redeem already returns 402 — the precedent)
- `shared-lib/errors/map.go` HTTPStatusFromError: 6014→402, 6002→409
- `shared-lib/errors/status.go` FromError (MetaError detection)

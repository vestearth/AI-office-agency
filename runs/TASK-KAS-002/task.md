# TASK-KAS-002 — Fix hexagonal seam violation in casperacc-api payment service

## Problem

`internal/core/services/payment.go` imported the concrete adapter package
`internal/adapters/ubit` to call its package-level helpers
(`ubit.SignParams`, `ubit.DecryptSign`, `ubit.BuildSignString`) inside the local
`verifyUbitCallbackSign` function.

This breaks the hexagonal (ports & adapters) rule now written in
`casperacc-api/AGENTS.md`: `internal/core/*` must depend only on the interfaces
in `internal/core/ports`, never on a concrete `internal/adapters/*` package.
(Everything else was already clean — `s.ubit.CreateRecharge` goes through
`ports.UbitAdapter`. Only the callback signature check leaked the concrete
import.)

## Why it belongs in the adapter

Callback signature verification is UBIT-vendor-specific signing (AES key/IV,
param ordering, sign string format). Per the ports design that is adapter
territory — the adapter already owns `signRechargeRequest` and the AES key/IV
from config. The core service should only ask "is this callback authentic?"
through the port.

## Fix

1. **New** `internal/adapters/ubit/callback.go` — `func (a *Adapter)
   VerifyCallbackSign(payload models.UbitRechargeCallbackPayload) error`. Body is
   the exact logic moved out of the service; it uses the adapter's own
   `aesKey`/`aesIV` fields and the package's existing `formatAmount` helper (same
   `FormatFloat(v,'f',-1,64)` as the old `formatUbitAmount`). Param map, sign
   comparison, and decrypt-fallback are byte-for-byte identical — no behavior
   change.
2. **`internal/core/ports/adapters.go`** — added
   `VerifyCallbackSign(payload models.UbitRechargeCallbackPayload) error` to the
   `UbitAdapter` interface.
3. **`internal/core/services/payment.go`** —
   - removed the `internal/adapters/ubit` import;
   - `HandleUbitCallback` now calls `s.ubit.VerifyCallbackSign(payload)` behind a
     new `s.ubit == nil` guard (prevents a nil-interface panic; the old free
     function didn't depend on `s.ubit`);
   - deleted the now-dead `verifyUbitCallbackSign` and `formatUbitAmount`.
4. No change needed in `cmd/main.go` — it already injects
   `var ubitAdapter ports.UbitAdapter = ubit.New()`; `*ubit.Adapter` now also
   satisfies the extended interface.

## Verification (all clean, run from `casperacc-api/`)

```bash
# seam is gone:
grep -rn 'casperacc-api/internal/adapters\|casperacc-api/internal/handler' internal/core/   # no matches
gofmt -l .        # clean
go vet ./...      # clean
go build ./...    # ok
go test ./...     # ok (ubit pkg tests pass; no service tests exist)
```

## For the reviewer / next person

- Behavior parity is the key thing to confirm: the sign logic was relocated, not
  rewritten. Diff `callback.go` against the old `verifyUbitCallbackSign` if in
  doubt.
- There is **no unit test** for `VerifyCallbackSign` yet (there was none for the
  old function either). Adding one against a known UBIT sample callback would be
  a good hardening follow-up.

## Out of scope (noted, not done)

- Stripe webhook verification (`HandleStripeWebhook`) still calls the `stripe-go`
  `webhook`/event SDK directly inside the core service. That's a third-party SDK,
  not an `internal/adapters/*` import, so it does not violate the seam grep — but
  it does bend the "no vendor SDK in core" spirit. Left for a separate task to
  avoid scope creep.

## Acceptance

- `internal/core/*` imports no `internal/adapters/*` or `internal/handler/*`.
- UBIT callback verification behavior unchanged.
- `gofmt`/`vet`/`build`/`test` clean.

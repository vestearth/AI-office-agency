# TASK-EAR-227 — Admin cannot set a wallet balance to zero

## Type

fix

## Priority

medium

## Discovered

2026-08-07, while scoping TASK-EAR-226 (the Wallet audit publisher). Not caused
by that work — long-standing.

## Symptom

An admin using the backoffice **Manual Wallet** panel cannot set a player's coin,
points or diamonds to **0**. Entering 0 and saving reports success, and the
balance is left at its previous value. There is no error and no warning: the save
toast fires, the panel reloads, and the old number reappears.

## Root cause — two layers, and the proto is the real one

`Games-Labs-Wallet/internal/core/services/walletsvc/service.go:335-343`:

```go
if coin == 0     { coin = w.CoinAmount }
if points == 0   { points = w.Points }
if diamonds == 0 { diamonds = w.Diamonds }
```

Zero is treated as "leave unchanged". That looks like a careless guard, but the
service has no alternative today, because the contract cannot express the
difference:

`shared-lib/proto/admin/adminwalletpb/adminwallet.proto:95-100`

```proto
message UpdateWalletBalanceRequest {
  string user_id = 1;
  int64  coin     = 2;
  int64  points   = 3;
  int64  diamonds = 4;
}
```

These are plain proto3 scalars with **no field presence**. On the wire, `coin: 0`
and "coin was never set" are byte-identical — both decode to `0`. The service
genuinely cannot distinguish "set this to zero" from "don't touch this", so the
`== 0` guard is the symptom, not the cause. **Fixing only the service would break
callers that legitimately omit a currency.**

## The fix

1. **shared-lib** — mark the three fields `optional`:

   ```proto
   optional int64 coin     = 2;
   optional int64 points   = 3;
   optional int64 diamonds = 4;
   ```

   `optional` in proto3 adds presence tracking via a synthetic oneof. **Field
   numbers do not change and the wire format for a set value is unchanged**, so
   this is backward compatible: an old client that sends `coin: 5` still decodes
   to a present 5, and one that omits the field now decodes as absent rather than
   0 — which is exactly the distinction we want. Do not renumber. Regenerate with
   `make buf`; never hand-edit generated files.

   ⚠️ **Publish gate (AGENTS.md:275)**: this is a standalone shared-lib PR that
   stops at the PR. Wallet cannot bump until the operator merges it.

2. **Games-Labs-Wallet** — bump shared-lib, then replace the `== 0` guards with
   presence checks (`req.Coin != nil` / the generated `HasCoin()`-style accessor,
   whichever the generator produces). An absent field keeps the current value; a
   present `0` sets the balance to zero.

   `AdminSetWalletBalances` takes plain `int64`s today
   (`service.go:322`), so its signature needs to carry presence too — pointers or
   an explicit per-currency struct. Note that TASK-EAR-226 has just changed this
   function's return signature to include `[]models.WalletBalanceChange`; **check
   whether Wallet#12 has merged and rebase accordingly** rather than assuming.

3. **api-gateway** — needs its own staging-lane shared-lib bump. It owns the wire
   format for anything registered through grpc-gateway, and omitting it is how
   TASK-EAR-225 shipped five green PRs with a retired field still on the wire.
   **This has now bitten six times; treat the gateway as a mandatory consumer.**

## Frontend — verify, probably no change needed

`Games-Labs-backoffice/app/pages/admin/manage/player/edit/[id].vue:629-637` sends
**all three fields on every save**, as absolute target values from the form:

```js
body: { coin: String(...), points: String(...), diamonds: String(...) }
```

So after the fix all three arrive present, and the panel's existing
"absolute target value" semantics start working correctly for zero.

**But confirm before shipping**: what the form holds for a currency the admin did
not touch. It is seeded from the loaded balance, so it should re-send the current
value harmlessly — but if any path can leave a field blank and serialise it as
`0`, that path would now *zero the balance* instead of leaving it. That is the one
way this fix could cause a money incident, so prove it rather than assuming.

## Money-path constraints

- Test the zero case for **all three currencies**, and remember POINT is a
  separate subsystem (`AddPoints`/`DeductPoints`, not `ApplyTransaction`;
  `Debit` explicitly rejects POINT, `service.go:196`).
- The three mutations are separate transactions and non-atomic — a partial
  failure is possible and already handled that way by TASK-EAR-226's audit.
- Negative values are already rejected (`service.go:345-347`); keep that.

## Interaction with TASK-EAR-226

The audit publisher deliberately emits **no event for a currency the service left
unchanged**, which today silently includes "the admin asked for zero and was
ignored". Once this fix lands, a genuine set-to-zero becomes a real change and
will correctly produce an audit event. No audit-side change should be needed —
confirm that rather than assuming.

## Acceptance criteria

- Setting each of coin, points and diamonds to 0 via the backoffice panel
  actually zeroes the balance, verified on staging.
- Omitting a field still leaves that balance untouched — regression test.
- Negative values still rejected.
- `go build` / `go vet` / `go test ./...` green in every touched repo.
- shared-lib PR stops at the gate; Wallet and api-gateway bumps follow the merge,
  all landing on the same pseudo-version (compare `go.sum` h1, not just the
  version string).

## Out of scope

- The audit publisher itself (TASK-EAR-226).
- Any change to how the ledgers record movements.

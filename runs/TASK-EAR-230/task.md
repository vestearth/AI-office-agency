# TASK-EAR-230 — 🔴 Manual Wallet panel can send a spurious `0` — blocks TASK-EAR-227

## Type

fix

## Priority

high

## Why this is urgent now

Today these paths are **harmless**, because `0` means "leave unchanged" in
`walletsvc.AdminSetWalletBalances`. TASK-EAR-227 removes exactly that behaviour so
an admin can finally zero a balance — which turns every one of them into a way to
**wipe a real player's balance with one click**.

**TASK-EAR-227's two PRs (Games-Labs-Wallet#13, api-gateway#40) must not merge
until this ships.** Found by tracing the frontend rather than assuming it was
safe, which is the only reason it was caught before deploy rather than after.

## The three paths — all verified in source on `origin/main`

`Games-Labs-backoffice/app/pages/admin/manage/player/edit/[id].vue`

### 1. A cleared input becomes `0` (`onWalletAmountInput`, ~:603-609)

```js
const digits = el.value.replace(/\D/g, '')
const n = digits === '' ? 0 : clampWalletUint(Number(digits))
```

There is no blank sentinel. Clear a box to retype a number, mis-click Save, and
that balance goes to zero. This is the most likely of the three to actually
happen — it is ordinary typing behaviour.

### 2. A missing or renamed currency key reads as `0`, and the panel still trusts it

`walletAmountNum` (~:286-293) returns `0` for `undefined`:

```js
function walletAmountNum(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.floor(v))
  if (typeof v === 'string' && v.trim() !== '') { ... }
  return 0          // <-- undefined lands here
}
```

and the loader sets `walletBalanceConfirmed.value = true` (~:439) whenever a
`parsed` object exists — **without checking that the currency keys were actually
present**. So a response that drops or renames `coin` yields `coin: 0`, Save stays
enabled, and one click zeroes it.

Not hypothetical: the parser already tolerates **three different spellings per
currency**, which is direct evidence that key drift happens on this endpoint.

### 3. `{ data: <any object> }` is accepted as a wallet (~:316-326)

```js
const inner = d.wallet
if (inner && typeof inner === 'object' && !Array.isArray(inner)) { r = inner }
else { r = d }        // <-- any object at all becomes the wallet record
```

An unrelated 200 body shaped `{data: {...}}` passes as a wallet with all three
balances at `0` and `confirmed = true`. One click wipes all three.

## What already works — do not undo it

The hard failure paths are properly guarded and should stay exactly as they are:
`walletBalanceConfirmed` plus the early return at ~:615 and the disabled Save at
~:964 already cover a fetch throw, a 404, a null body, a non-200 envelope and a
missing `wallet` object. The PATCH at ~:626 is the **only** writer of this
endpoint anywhere in the backoffice, so fixing it here fixes it everywhere.

## The fix

The shape of it — exact implementation is the implementer's call, but it must
satisfy these:

1. **A cleared input must not mean zero.** Give the field a blank/`null` sentinel
   distinct from a real `0`, and block Save while any balance field is blank.
   An admin who genuinely wants zero must type `0`.
2. **Require the currency keys to be present before confirming.** `walletAmountNum`
   returning `0` for `undefined` is fine as a display default, but
   `walletBalanceConfirmed` must only be set when every currency was actually
   found in the response. A missing key is a parse failure, not a zero balance.
3. **Stop accepting an arbitrary object as a wallet.** The `r = d` fallback should
   require at least one recognised currency key before treating `d` as the record.

⚠️ **Preserve the designed UX** (standing operator rule). This is validation and
guard work, not a redesign — do not restyle the panel or change its layout. A
blocked Save should use whatever disabled treatment the button already has.

## Acceptance criteria

- Tests (`tests/*.test.mjs`) for each of the three paths: cleared input does not
  serialise as `0` and blocks Save; a response missing a currency key does not
  confirm; an arbitrary `{data:{}}` object is rejected.
- Typing a real `0` still works and still sends `0` — the whole point of
  TASK-EAR-227 is that this must reach the backend.
- The existing guards (fetch throw, 404, null, non-200, missing wallet) still
  behave as they do today — regression tests or explicit confirmation.
- Build/lint green.
- **PR only, do NOT merge** — backoffice `main` merge is a real k3s/ArgoCD deploy.
  State that in the PR body, along with the fact that this **unblocks
  TASK-EAR-227** and must deploy before Wallet#13 and api-gateway#40 merge.

## Out of scope

- The backend presence change itself (TASK-EAR-227).
- Any other panel on the player detail page.

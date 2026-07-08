# TASK-EAR-084: Orders exchange idempotency recovery after partial wallet failure

## Short Name

`orders-exchange-idempotency-recovery`

## Type

bug

## Priority

high

## Status

Opened 2026-07-07 (Claude advisory lane). **Implementation BLOCKED** until
TASK-EAR-083 round 3 lands its Games-Labs-Order changes — both edit
`internal/core/services/ordersvc/service.go` `CreateExchangeOrder` in the same
repo/working tree, so concurrent edits would collide. Start only after the
EAR-083 round-3 Order commit is in and the working tree is clean.

## Background

Surfaced by the codex adversarial review of TASK-EAR-083 round 2 as Order-side
finding **F4**, and deliberately scoped OUT of EAR-083 because it is
**pre-existing** and affects **all** exchange orders (fixed-package tier
exchange too), not just the new custom path — the offending early-return is not
in the EAR-083 diff.

`Games-Labs-Order/internal/core/services/ordersvc/service.go` `CreateExchangeOrder`
returns an existing order for the client `idempotency_key` before any wallet
recovery:

```
existing, _ := GetByIdempotencyKey(key)
if existing != nil { return existing, nil }
```

The wallet exchange itself is idempotent under a recoverable key
`order:<orderID>`. But if the wallet **debited diamonds and then failed** on
credit/response, the order is marked failed and a client retry with the same
`idempotency_key` stops at the existing (failed) order and **never replays
`order:<orderID>`** into Wallet. The exchange can strand with diamonds debited
and no coins, unrecoverable via retry. The same shape applies if the wallet
succeeded but settlement failed: the order stays non-fulfilled and retries do
not re-settle or re-query Wallet.

## Goal

Make exchange-order retries recover a partially-completed wallet exchange
idempotently, instead of treating an existing pending/failed order as terminal.

## Scope

### Target Services

| Service | Reason |
| --- | --- |
| `Games-Labs-Order` | Owns `CreateExchangeOrder`, the wallet adapter call, and order settlement/status. |
| `ai-dev-office` | Tracks this work and verification. |

### Expected changes (Games-Labs-Order)

- In `CreateExchangeOrder`, do not short-circuit on any existing idempotency row.
  When an existing exchange order is **fulfilled**, return it (current behavior).
  When it is **pending/failed and not known to be pre-debit**, re-enter an
  idempotent recovery path keyed by `order:<orderID>`: retry/reconcile
  `ExchangeDiamondsToCoins` (idempotent under that key), then settle the order.
- Only treat an existing row as terminal when it is fulfilled, or its failure is
  known to be **pre-debit** (e.g. validation/package errors that never called
  Wallet) — those may safely fast-fail without a wallet replay.
- Preserve the fixed-package and custom (EAR-083) exchange behavior for the
  happy path; this only changes the retry/recovery branch.

## Acceptance Criteria

- A retry with the same `idempotency_key` after a wallet debit-success /
  credit-fail completes the exchange without a second debit (relies on the
  `order:<orderID>` wallet idempotency).
- A retry after a wallet-success / settlement-fail re-settles the order rather
  than returning it unfulfilled.
- Pre-debit failures (validation, package-not-found, package-not-custom) still
  fast-fail on retry without a wallet call.
- Tier (fixed-package) and custom exchange happy paths unchanged.
- Focused Order tests pass; `go build ./...`.

## Test (explicit, from the review)

Add a test where the first Wallet call debits/records `order:<orderID>` then
returns an error; the client retries with the same `idempotency_key`; Order
completes without a second debit.

## Risks

- Double-debit if recovery does not correctly reuse the `order:<orderID>`
  wallet key — the recovery MUST be idempotent, never a fresh debit.
- Distinguishing pre-debit vs post-debit failure requires reliable order/wallet
  state; if ambiguous, prefer an idempotent wallet reconcile (safe under the
  same key) over assuming terminal.
- Branch from `staging` AFTER EAR-083 round 3 merges (or rebase) to avoid a
  conflict in `ordersvc/service.go`.

## Verification Plan

- `ruby ai-dev-office/validate-yaml.rb TASK-EAR-084`
- Order focused tests incl. the debit-success/credit-fail retry test.
- `go build ./...` for Games-Labs-Order.

---

## Deferred — safe design (for the dedicated cycle)

A first naive attempt (Codex, preserved on `wip/TASK-EAR-084-f4-recovery` @ 7fcfb60)
re-invoked the wallet under `order:<orderID>` for any existing non-fulfilled
exchange order and re-settled. Adversarial review found two highs; it was reset
off the EAR-083 push (operator decision B — keep the clean EAR-083 push separate).

### Findings the safe version must avoid
- **F6 — non-authoritative custom coin on recovery.** Recomputing coin from the
  current live `exchange.custom` rate and returning it as authoritative can
  differ from what the wallet actually moved (the wallet is idempotent under
  `order:<orderID>` and `WalletExchangeResult` does not carry the moved coin).
- **F7 — double-settle race.** Recovering every non-fulfilled order (incl.
  in-flight `StatusPending`) plus a settlement with no status predicate lets a
  retry racing the original request move currency concurrently and publish the
  turnover event twice.

### Safe design
1. **Recover only durable `StatusFailed` exchange orders** — never `Pending` /
   `Fulfilling` (those may belong to a still-running original request).
2. **Compare-and-set settlement** — the settlement UPDATE must carry a status
   predicate (`... WHERE status IN (failed/…)`), and turnover is published only
   when the transition actually occurred (row affected). Prevents double-settle
   / double-publish under concurrent retries.
3. **Authoritative coin** — do NOT return a locally recomputed coin as
   authoritative on recovery. Either (a) persist the applied coin/rate at order
   creation (small migration) and load it on recovery, or (b) have Wallet return
   the original moved amounts for an idempotent exchange, or (c) mirror the
   EAR-083 replay fail-safe: return `Replayed` with only the authoritative
   `SpentDiamonds`, no fabricated coin.
4. Tests: (a) debit-success/credit-fail then retry completes without a second
   debit; (b) concurrent retry vs original — pending not recovered, fulfilled
   settles + publishes turnover at most once; (c) custom recovery after a rate
   change does not return/persist a non-authoritative coin.

### Branch
Fresh from `staging` after EAR-083 merges (avoids the `ordersvc/service.go`
conflict), or continue from `wip/TASK-EAR-084-f4-recovery` and rework.

---

## Round 2 decision — Option 1 (recover fixed-package only; no migration)

The safe rework closed F7 (in-flight guard + compare-and-set settlement) but the
FINAL adversarial review found F8 [high]: custom recovery still MOVES currency
using a live-rate recompute (custom coin is not persisted), so a custom order
that failed before the wallet recorded `order:<orderID>` can, after a rate
change, debit the original diamonds and credit at the new rate — a
non-authoritative movement (the response already hides the amount via
`Replayed`, but the wallet movement itself is wrong). Fixed-package coin is
deterministic from the snapshot, so fixed recovery is safe.

Operator chose **Option 1** (no migration):
- **Fixed-package failed exchange orders → auto-recover** (unchanged: coin is
  deterministic from `PackageSnapshot`).
- **Custom failed exchange orders (`code_name == "custom"`) → do NOT auto-move
  currency.** Return a retryable / manual-recovery error instead of issuing a
  live-rate wallet call. No `priceCustomExchange` call, no
  `ExchangeDiamondsToCoins` on this path.
- Full authoritative custom recovery (persisting coin/rate at order creation) is
  deferred to a follow-up that accepts a migration.

Rationale: F4's original scope is the pre-existing tier (fixed-package) exchange
strand; custom exchange is a brand-new, not-yet-deployed feature, so deferring
its recovery is low-risk. This closes F8 with no migration.

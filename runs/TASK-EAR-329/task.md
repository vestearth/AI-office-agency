# TASK-EAR-329 — Diamond as a redemption price currency

## Type

feature

## Workstream

backend

## Priority

high

## Created

2026-09-07

## Parent / Epic

- Parent: none
- Epic: Diamond redemption
- Sequence: **1 of 1 for the backend + Backoffice**. Mobile is a human
  handoff, as in TASK-EAR-314.

## Goal

Player Detail's Summary shows "Total Redeem … Diamond". TASK-EAR-326 blanked it
to `—` because **no Diamond redemption exists anywhere in the backend**:
`redemption_items.point`, `user_redemption_items.point_spent` and
`redemption_item_attempts.point_amount` are all BIGINT points, and the service
calls `RedeemPoints(userID, points, reason, idempotencyKey)` with reason
`redeem_points`.

Make the flow real: a redemption item can be priced in **POINT or DIAMOND**,
and redeeming a DIAMOND-priced item debits diamonds.

## Locked decisions (operator 2026-09-07)

These are the operator's words, recorded as the contract for this run.

1. **Extend the existing Redemption feature; do not build a second shop.**
   Order already owns the catalog, quota, code/gift fulfilment and
   `user_redemption_items`. A parallel Diamond shop would duplicate every one
   of those.
2. **One currency per item — the player never chooses.** Phase 1 does **not**
   offer "pay with Points or Diamonds" on the same item; that would add a
   pricing choice, extra idempotency states and UI complexity for no product
   gain. Each item carries exactly:
   - `price_currency = POINT | DIAMOND`
   - `price_amount   = integer`
3. **Snapshot both fields on both ledgers** — `redemption_item_attempts` and
   `user_redemption_items`.
4. **Never re-read the current price on retry, and never accept a price from
   the client.** The attempt row is the authority once it exists.
5. **Symmetric Wallet operations per currency:**
   - `POINT   → RedeemPoints / RefundPoints`
   - `DIAMOND → DebitDiamond / RefundDiamond`
6. 🔴 **Diamond compensation is the real gap.** `DebitDiamond` and
   `CreditDiamond` already exist (`walletpb/wallet.proto:57`, `:65`) but
   `CreditDiamond` is a **staff-facing balance adjustment**. It must not be
   reused to refund a failed redemption — this money path needs its own
   `RefundDiamond`, mirroring `RefundPoints`
   (`user_id`, `diamonds`, `reason`, `idempotency_key`,
   `reference_redemption_id` — `wallet.proto:311`).

Assumed and open for correction: **Backend + Backoffice in this run, mobile by
handoff.** The operator answered the currency question and re-stated it for the
client question, so the client scope was never separately confirmed.

## Evidence that drove the scope

- `redemption_items.point BIGINT` (`migrations/011`),
  `user_redemption_items.point_spent BIGINT` (`023`),
  `redemption_item_attempts.point_amount BIGINT CHECK (>= 0)` (`036`).
- `036` is a **forward-only safety ledger** whose own comment says rows are
  retained across application rollback "so an already-debited or refunded
  attempt can never be replayed as a fresh claim". Any new column must respect
  that: additive, defaulted, never rewritten for an existing row.
- `RedeemRedemptionItem` (`ordersvc/service.go`) resolves an existing attempt
  by state first (`Refunded` → stored error, `Compensating` → compensate,
  `Processing` → continue) and only then loads the item and validates
  window/status. So the retry path already reads the ATTEMPT, not the item —
  decision 4 is a constraint the new currency must not break.
- `walletpb` already has `DebitDiamond` / `CreditDiamond` as S2S RPCs, and
  `RedeemPoints` / `RefundPoints` as the money-path pair. Only `RefundDiamond`
  is missing.
- Redemption quota is enforced per-player and total (TASK-EAR-087, in-tx,
  Asia/Bangkok day). Quota is currency-independent and must stay that way.

## Gates

Sequential; **Gate 1 stops for operator publication of shared-lib**, as in
TASK-EAR-314.

| # | Repo | Work |
| --- | --- | --- |
| 1 | `shared-lib` | Additive `price_currency` + `price_amount` on the redemption item and both ledger messages; `RefundDiamond` RPC + request/response mirroring `RefundPoints`. Regenerate, document, **stop for publish.** |
| 2 | `Games-Labs-Wallet` | Implement `RefundDiamond` — its own idempotency key space, symmetric with `RefundPoints`; never routed through the staff `CreditDiamond` path. |
| 3 | `Games-Labs-Order` | shared-lib bump; migration adding `price_currency`/`price_amount` to `redemption_items`, `redemption_item_attempts`, `user_redemption_items`, all idempotent and defaulted to POINT + the existing point column; redeem branches on the item's currency; attempt snapshot is authoritative on retry; compensation calls `RefundDiamond` for DIAMOND attempts. |
| 4 | `api-gateway` | Same published shared-lib bump so REST JSON exposes the new fields. **Required — the gateway owns the wire format**; a green build is not proof, grep the raw response body. |
| 5 | `Games-Labs-backoffice` | Redemption item admin form gains the currency selector; Player Detail's Summary "Diamond" figure binds to real Diamond redemptions. |
| 6 | handoff | Mobile contract note in `knowledge-base`; the Android reference repo is not edited. |

## Acceptance criteria

1. A redemption item stores exactly one `price_currency` and one
   `price_amount`; the legacy `point` column keeps working for existing rows
   (defaulted to POINT).
2. Redeeming a DIAMOND item debits diamonds via `DebitDiamond` and never
   touches points; redeeming a POINT item is byte-for-byte unchanged.
3. A retry reads currency and amount from the **attempt**, never from the item
   — proven by a test that changes the item's price between attempts and
   asserts the original snapshot is honoured.
4. A price supplied by the client is ignored; the server derives it.
5. A failed DIAMOND redemption compensates through `RefundDiamond`, not
   `CreditDiamond`, and a replayed compensation does not double-refund.
6. Quota (per-player and total) behaves identically for both currencies.
7. Every migration statement is idempotent — Order replays them, and `036`'s
   forward-only guarantee is preserved.
8. Backoffice can create and edit an item in either currency, and the Detail
   Summary's Diamond figure is real.
9. Tests seen RED before each fix; Order's integration suite runs against a
   real Postgres.

## Non-goals

- Letting a player choose the currency for one item (decision 2).
- Any change to the Missions Diamond store (`store_purchase_operations`).
  Those Pass/Avatar purchases already show under Purchase → Special Pass /
  Limited Avatar and must **not** be folded into "Total Redeem → Diamond", or
  the same spend is counted twice on one page.
- Line and Address (operator: Diamond only).
- Mobile client work.

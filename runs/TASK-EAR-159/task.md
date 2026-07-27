# TASK-EAR-159 — Wire Earned / Redeem (Point) history on Player Detail page; scope Send-coin as prep only

## Context

From the 2026-07-27 Player Detail page audit (knowledge-base memory
`detail-page-backend-epic`): History Transaction → **Earned → Point**,
**Redeem → Point**, and **Send coin → Sent/Received** are all still mock,
and the Summary sidebar's Total Coins Received/Purchased/Free/Wager/
Used/Played and Total Redeem/Diamond/Point figures share the same root
cause — **no wallet-transaction read API exists today**, and no clean
category mapping exists to bucket raw ledger rows into
Earned/Redeem/Send-coin.

Known data facts (verify against current code before implementing):

- `wallet_transactions` has data but zero admin read API. Its `type` enum
  (DEPOSIT/WITHDRAW/CREDIT/DEBIT/BET/WIN/REFUND/ADD_DIAMOND) does **not**
  map cleanly to Purchase/Earned/Redeem/Send-coin — real intent lives in
  free-text `metadata.reason`.
- `wallet_points_ledger` has its own `ListPointHistory` (Point-currency
  only, not exposed via any admin proto —
  `shared-lib/proto/admin/adminwalletpb/adminwallet.proto` only has
  `GetWalletBalance`/`UpdateWalletBalance`/rate-catalog RPCs today).
- Real purchases live in a separate table, `payment_transactions` (already
  covered by TASK-EAR-137 / TASK-EAR-158 via Order, not in scope here).

## Operator guidance

Send-coin is expected to land in a **later phase** (its sender/receiver
semantics likely need product decisions this task shouldn't block on).
**Prep it if the investigation makes it cheap to include, but do not let
it hold up shipping Earned/Redeem.** It's fine if Send-coin ships nothing
this round.

## Objective

1. Design and get sign-off on a category-mapping rule from raw
   `wallet_transactions`/`wallet_points_ledger` rows to the
   Earned/Redeem/Send-coin buckets the Detail page needs (this is a
   product/data decision, not just plumbing — the existing `type` enum
   alone is not sufficient, per the audit).
2. Expose a new admin-scoped, paginated read RPC (extending or sitting
   alongside `ListPointHistory`) covering **Earned** and **Redeem** at
   minimum.
3. Wire `Detail/[id].vue` History Transaction → Earned/Redeem sub-tabs and
   the related Summary sidebar Point/Diamond totals to the new endpoint.
4. Investigate Send-coin (Sent/Received) feasibility against the same
   mapping and record findings — implement only if it turns out to be a
   near-zero-cost extension of the same RPC; otherwise leave it mocked and
   hand off a scoped follow-up for the later phase.

## Scope

- `Games-Labs-Wallet` — new/extended admin read RPC over
  `wallet_transactions` + `wallet_points_ledger`.
- `shared-lib/proto/admin/adminwalletpb` — new RPC + gateway binding.
- `api-gateway` — route binding for the new RPC.
- `Games-Labs-backoffice` — Earned/Redeem sub-tab wiring + Summary sidebar
  Point/Diamond totals (mirrors `useAdminPlayerPurchaseHistory.ts` pattern
  from TASK-EAR-137/158).

## Acceptance criteria

- A written category-mapping rule exists (in `dev-output.yaml` or a
  follow-up doc) explaining how raw transaction rows resolve to
  Earned/Redeem/Send-coin, with evidence from actual `metadata.reason`
  values seen in the data — not guessed.
- Earned → Point and Redeem → Point sub-tabs render real per-player rows.
- Summary sidebar Point/Diamond totals reflect real aggregates, not mock.
- Send-coin is either wired (if cheap) or explicitly left mocked with a
  clear, evidence-based note on what's missing for the later phase — no
  half-built Send-coin code.
- Coin totals (Received/Purchased/Free/Wager/Used/Played) are out of scope
  for this task unless the same RPC trivially covers them — flag separately
  if not.

## Out of scope

- Game tab (separate, larger epic — no backing data anywhere).
- Purchase → Special Pass / Limited Avatar (TASK-EAR-158, in progress).
- Contact (Facebook/Line/Address) and Device Info (IP/Serial) mock fields.
- The known IDOR in Order's `ListOrders` / `ListMyRedemptionItems` — unrelated
  service, do not touch here.
- Full Send-coin implementation if it requires new product decisions beyond
  the mapping rule above — defer to the later phase task explicitly.

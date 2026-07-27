# TASK-EAR-163 — Design the Special Pass / Limited Avatar purchase flow

## Context

Follow-up to [TASK-EAR-158](../TASK-EAR-158/task.md), which set out to wire
the Player Detail page's Purchase → Special Pass / Limited Avatar sub-tabs
and instead found the underlying purchase flow doesn't exist:

- No service anywhere creates a transaction record when a player buys a
  Special Pass or Limited Avatar today.
- Order owns a `SpecialItem` catalog (`ItemType` "pass"/"avatar") with
  admin CRUD RPCs only — no `PurchaseSpecialItem`/`BuySpecialItem` RPC.
- `models.OrderBuyItem` ("buy_item") is a defined-but-unused order type —
  zero real construction sites anywhere in the monorepo.
- The only adjacent flow is coupon complimentary grants
  (`CouponPassGrant`/`CouponAvatarGrant`, fulfilled via `reward_claim`
  orders) — a free-grant path, not a paid purchase path.
- `orderpb.Order` itself has no structured item-type field (generic `type`
  enum + free-text `description` only), so even a populated BUY_ITEM order
  couldn't distinguish Special Pass from Limited Avatar without a schema
  change regardless.

Full investigation evidence: `runs/TASK-EAR-158/dev-output.yaml`.

## Objective

This is a **design task, not an implementation task**. Produce a concrete
proposal for how a player actually purchases a Special Pass or Limited
Avatar, before any schema or RPC work starts.

## Open questions the proposal must answer

1. **Is this even in scope to build now**, or should Special Pass/Limited
   Avatar purchase stay unavailable to players until a later phase? (Don't
   assume "yes, build it" — confirm the product need first.)
2. **Pricing & inventory**: does `SpecialItem` (Order's existing catalog)
   already carry price/currency/stock fields sufficient for a real
   purchase, or does the catalog itself need extending?
3. **Transaction model**: extend `BUY_ITEM` orders with a structured
   `item_type`/`special_item_id` reference (reusing the existing but
   currently-unused enum value), or introduce a dedicated purchase
   RPC/table separate from generic Order? State the tradeoff.
4. **Fulfillment**: what actually happens on successful purchase — does
   the pass/avatar get granted the same way `CouponPassGrant`/
   `CouponAvatarGrant` already does it (reuse that grant mechanism), or
   does fulfillment need new logic?
5. **Idempotency/wallet safety**: any new spend path touches the wallet —
   check [[wallet-debit-point-contract]] and
   [[store-exchange-orders-catalog]] conventions (USE_ORDERS_CATALOG
   delegation pattern) before proposing a new direct-wallet path; a
   direct-wallet purchase path without Orders lifecycle/audit is a
   known no-ship pattern in this codebase.
6. Rough scope size (low/medium/high) and which services are touched.

## Scope

- Design/proposal only: `Games-Labs-Order`, `shared-lib/proto/orderpb` +
  `adminorderpb`, and how it'd surface to `Games-Labs-backoffice` (for
  TASK-EAR-158's original goal) once built.
- No schema migration, no proto change, no RPC implementation, no FE
  change in this task.

## Acceptance criteria

- Proposal answers all 6 questions with concrete evidence (file/table
  citations), not speculation.
- Recommends one transaction-model approach with a stated tradeoff, not
  just a list of options.
- Explicitly checks the purchase path against the existing
  Orders-catalog-delegation convention (no bypassing Orders' lifecycle/
  audit/idempotency for a new money-moving path).
- Ends at the proposal for operator review — does not automatically
  continue into implementation.

## Out of scope

- Actual schema/RPC/FE implementation — a follow-up task once the
  proposal is approved.
- Everything else already scoped separately: TASK-EAR-159
  (Earned/Redeem/Send-coin), TASK-EAR-160 (Game tab), TASK-EAR-161
  (Contact/Device Info), TASK-EAR-162 (gate check re-run), the Order IDOR.

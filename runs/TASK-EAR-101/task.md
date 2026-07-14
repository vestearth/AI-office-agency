# TASK-EAR-101: Approve Promotion Coupon behavior and settlement contract

Epic: Promotion Coupon end-to-end rollout. Investigation/general/high; partially
approved but still blocked on remaining operator decisions and Store Items
dependencies. No code.

## Locked decisions — operator 2026-07-13

- Discount Coupon has active/inactive status.
- Percentage Discount supports a maximum-discount cap.
- Coupon discount may stack with an existing package discount.
- Coupon is consumed only after payment success.
- Failed/cancelled attempts keep an audit record and release reserved quota.
- Refund records a refund transition and restores quota exactly once.
- Complimentary rewards are granted after payment success.

## Approved quota semantics — operator 2026-07-14

Use an atomic usage ledger and explicit counters:

- **Global quota:** maximum successful consumptions for the campaign across all
  users. `total_quota=0` means unlimited only when an explicit
  `is_total_quota_unlimited=true` flag is set; avoid implicit zero semantics.
- **Global daily quota:** maximum successful consumptions across all users in one
  campaign day.
- **One-time per player:** maximum one successful consumption for that user over
  the campaign lifetime.
- **Daily per player:** maximum `per_player_limit` successful consumptions for
  that user in one campaign day.
- **Lifetime per player:** maximum `per_player_limit` successful consumptions for
  that user over the campaign lifetime.
- Campaign day boundary is `00:00 Asia/Bangkok`, matching the current Order
  redemption quota rule.

At order creation, create a short-lived **reservation**, not a consumption. On
payment success, atomically transition `reserved -> consumed`. Failed/cancelled
orders transition `reserved -> released`; refunds transition
`consumed -> refunded`. Every transition is idempotent and append-audited so
quota can be restored exactly once without deleting history.

## Approved All Packages contract — operator 2026-07-14

`package_item_ids` is a UUID list. Putting the literal string `all` in that list
mixes two meanings and breaks UUID validation. Recommended contract:

```text
applies_to_all_packages: true
package_item_ids: []
```

or, for selected packages:

```text
applies_to_all_packages: false
package_item_ids: [uuid, uuid]
```

Invariant: `true` requires an empty list; `false` requires at least one package.
This is explicit, backward-compatible as an additive field and avoids copying
every current package ID into an "all" coupon.

## Approved pricing and rounding rule — operator 2026-07-14

- Apply package discount first, then apply Coupon to the already-discounted
  price because stacking is approved.
- Fixed Coupon must declare `discount_currency` and may apply only when it
  matches the order currency.
- Store fixed amounts as integer minor units, not floating point. Currency
  exponent comes from one server-side registry.
- Percentage calculation uses decimal arithmetic; apply the maximum cap in the
  order currency, then round once to minor units at the end.
- Final payable amount is never below zero.

## TASK-EAR-105 client scope clarification

TASK-EAR-105 means changing the actual Website checkout and Mobile checkout that
send `coupon_code`, show the authoritative preview and map stable coupon errors.
This workspace currently contains the Games Labs backend repos and Backoffice,
but no confirmed Games Labs Website/Mobile UI checkout repository. `casperacc`
is a separate product and is not assumed to be the client.

Operator confirmed 2026-07-14: no Website/Mobile checkout repository exists
under this workspace root (only backend services, `Games-Labs-backoffice`, and
`casperacc`, which is a separate product). TASK-EAR-105 is scoped to the API
handoff, contract examples and backend integration tests only. It must be
amended to cover actual client code once the operator supplies or confirms the
Website/Mobile repo names.

## Approvals — operator 2026-07-14

1. Quota semantics and Bangkok day boundary — approved as recommended above.
2. Explicit `applies_to_all_packages` contract — approved as recommended above.
3. Package-discount-first pricing order and fixed-currency/minor-unit rule —
   approved as recommended above.
4. Website/Mobile checkout repository — none exists in this workspace;
   TASK-EAR-105 scoped to backend/API-only until a client repo is identified.

TASK-EAR-099 (Store Items) is merged, delivering the stable `special_item_id`
that Coupon needs. TASK-EAR-100 (Mobile/Missions catalog convergence) remains
a separate, parallel track and is not a hard prerequisite for Coupon
Admin/backend implementation.

Acceptance: approved Admin/public field matrix; atomic quota/ledger rules;
settlement/refund state machine; authoritative pricing/stacking/rounding; stable
error codes; client ownership; approver/date recorded; TASK-EAR-102 through 105
have no invented product assumptions. — met; task closed.

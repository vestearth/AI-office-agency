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

## Recommended quota semantics — awaiting approval

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

## All Packages clarification — awaiting approval

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

## Pricing and rounding recommendation — awaiting approval

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

Until the client repositories are identified, TASK-EAR-105 may own the API
handoff, examples and backend contract tests only. Its affected client files
must be amended after the operator supplies or confirms the Website/Mobile repo
names.

## Remaining approvals

1. Quota semantics and Bangkok day boundary above.
2. Explicit `applies_to_all_packages` contract above.
3. Package-discount-first pricing order and fixed-currency/minor-unit rule.
4. Actual Website/Mobile checkout repository names for TASK-EAR-105.

Coupon implementation also waits for Store Items TASK-EAR-099 and canonical
Mobile boundary TASK-EAR-100 so stable `special_item_id` references exist.

Acceptance: approved Admin/public field matrix; atomic quota/ledger rules;
settlement/refund state machine; authoritative pricing/stacking/rounding; stable
error codes; client ownership; approver/date recorded; TASK-EAR-102 through 105
have no invented product assumptions.

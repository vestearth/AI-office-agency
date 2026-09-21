# TASK-EAR-366 — "Total Redeem" mixes two refund rules and counts only half the redemptions

- Short name: `total-redeem-refund-and-count`
- Type: fix / frontend
- Workstream: frontend
- Priority: medium
- Created: 2026-09-18
- Repo: `Games-Labs-backoffice` (base: `main`; local checkout was on
  `task/TASK-EAR-362` @ `725a30d` — branch from `main`, not from that)

## Defects

**A. Point does not net refunds; Diamond does.**

| currency | refund handling | evidence |
| --- | --- | --- |
| Diamond | subtracts count **and** amount for `refund_redemption_item`, clamps at 0 | `useAdminPlayerSendCoinHistory.ts:175` |
| Point | `totalPoints = items.reduce((s, i) => s + Math.abs(num(i.pointsDelta)), 0)` — no subtraction | `useAdminPlayerPointHistory.ts:170` |

Two figures in one box, two different rules. A failed-and-refunded Point
redemption still inflates the total.

**B. "Time" counts Point redemptions only.**

`totalRedeem` is written solely from the Point fetch
(`Detail/[id].vue:530`). `fetchRedeemDiamondTotal` already returns its own
`count`, and that value is dropped on the floor. A player who redeemed only
with Diamonds reads `0 Time` beside a non-zero Diamond figure — in the same
box, contradicting itself.

## This completes an existing decision, it does not overturn one

`wallet_history_reasons.go:14-17` (TASK-EAR-159) states that reversal reasons
are deliberately excluded from the Earned/Redeem allowlists because they
"should render as a status/delta on the original row, not a new Redeem line
item", and that "that reconciliation is a caller/FE-layer decision, not
enforced here."

So the FE was always the place to net refunds. TASK-EAR-329 did it for
Diamond. Point was left behind. The comment in EAR-329 — "a pre-existing
over-count, flagged rather than changed here, because altering a live figure
is not this task's call" — was that task staying in its lane, not a ruling
that the Point figure is right.

## Reason pairs (both sides needed — Point has two, Diamond has one)

| redeem reason | its reversal | written by |
| --- | --- | --- |
| `redeem_points` | `refund_points` | `Games-Labs-Order/internal/core/services/ordersvc/service.go:504` |
| `redeem_redemption_item` | `refund_redemption_item` | same file, `:1411` |
| `redeem_redemption_item` (DIAMOND) | `refund_redemption_item` | same file, `:1409` |

`REDEEM_POINT_REASONS` today is `['redeem_points', 'redeem_redemption_item']`
(`useAdminPlayerPointHistory.ts:57`). **Do not assume one refund reason** —
the Diamond implementation only needed `refund_redemption_item`, and copying
it verbatim would silently miss every `refund_points` reversal.

## Scope

1. Net refunds out of the Point aggregate: fetch the redeem reasons **and**
   their two reversals, subtract both the count and the points, clamp at 0 the
   way the Diamond path does (a refund whose original debit is outside the
   fetched range must not render a negative).
2. `Time` = net Point redemptions **+** net Diamond redemptions.
3. Failure handling: `Time` spans both sources, so if **either** load fails the
   whole box dashes. Never render a count sourced from one leg as if it were
   complete — that is the same class of defect TASK-EAR-177 fixed for the
   history rows.
4. Regression tests, each observed failing first:
   - a Point redemption reversed by `refund_points` is excluded from the total;
   - the same for `refund_redemption_item`;
   - a Diamond-only redeemer shows a non-zero `Time`;
   - a failed Diamond load dashes `Time`, not just the Diamond figure.

## Out of scope

- The six coin aggregates. Separate work, still blocked on a PM ruling; see
  `runs/TASK-EAR-364/task.md`.
- Changing what the History tab's Redeem sub-tab lists. EAR-159 ruled reversals
  render as a delta on the original row, not as new line items — this run
  touches the Summary aggregate only.
- Any backend change. `ListPointHistoryFiltered` / `ListWalletTransactionHistory`
  already accept an arbitrary caller-supplied reason list by design
  (`wallet_history_reasons.go:9-12`), so the reversal reasons are fetchable
  today.

## Deploy

`Games-Labs-backoffice` `main` has no PR CI gate — merging to `main` deploys.
Treat merge as release.

**Admin-visible numbers will change.** Point totals drop for any player with a
refunded redemption, and `Time` rises wherever Diamond redemptions exist. Both
are corrections, but say so in the PR body so nobody reports it as a
regression.

## Acceptance criteria

- Point and Diamond figures in the box follow the same refund rule.
- `Time` equals net Point redemptions plus net Diamond redemptions.
- Either load failing dashes the box rather than showing a partial count.
- No negative count or amount is renderable.
- All four regression tests were observed failing before the fix.
- `npm test` passes in full.
- Card layout is visually unchanged.

## Amendment to scope item 3 (2026-09-18, implementer = author of this file)

Item 3 said "if **either** load fails the whole box dashes". Implemented
instead as: **Time** dashes unless both legs loaded; **Point** and **Diamond**
each dash only on their own failure. Blanking a correct figure because the
other request failed would undo the per-leg state TASK-EAR-329 added on
purpose ("one can fail while the other succeeds"). The acceptance intent —
never render a one-legged count as complete — is unchanged and tested.

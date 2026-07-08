# TASK-EAR-087: Redeem-time enforcement for E-Voucher player/per-day quota rules

## Short Name

`order-redeem-player-quota-enforcement`

## Type

bugfix

## Priority

high

## Parent / Epic

- Parent: `TASK-EAR-086`
- Epic: Redemption admin management

## Status

Opened 2026-07-08 as the backend follow-up recorded by TASK-EAR-086 (AC #8).
The Backoffice edit Setting tab now lets operators configure player-quota rules,
but source review confirmed the redeem path does not enforce them.

## Background — the gap

`Games-Labs-Order/internal/core/repositories/redemption.go` →
`RedeemRedemptionItem` (func at ~L689) enforces **only** the item total quota:

```go
if locked.TotalQuota > 0 && locked.TotalRedeemed >= locked.TotalQuota {
    return nil, errors.New("redemption item quota exceeded")   // ~L721
}
```

It then inserts a `user_redemption_items` row and increments
`quota_used` / `total_redeemed`. There is **no** per-user / per-day gate:

- `player_quota_condition` (`Unlimited redemptions` / `One-time use only` /
  `Limited to one claim per day per player`; legacy value `Daily limit` is
  normalized to that phrase by the Backoffice) — persisted (insert/update +
  `modelRedemptionItemToPB`) but never read at redeem time.
- `limit_day_per_player` — persisted, never enforced.
- `is_quota_limit_per_day` / `quota_limit_per_day` (E-Voucher per-day total) —
  persisted, never enforced.

Confirmed by grep: the only COUNT/date logic in `RedeemRedemptionItem` is the
`total_quota` guard; the other `COUNT(1)` calls in the file live in
`ListRedemptionItems` / `ListUserRedemptionItems`, not the redeem path.

**Impact:** an operator selecting "One-time use only" or "Daily limit" (or the
per-day quota toggle) gets no runtime effect — a user can redeem repeatedly,
bounded only by `total_quota` and remaining `redemption_item_codes`. TASK-EAR-086
ships the Backoffice UI as **config-only** and explicitly does not present these
as live-enforced, pending this task.

## Scope

| Area | Action |
| --- | --- |
| `Games-Labs-Order/internal/core/repositories/redemption.go` | Enforce player_quota_condition, limit_day_per_player, and per-day quota inside `RedeemRedemptionItem` (inside the `FOR UPDATE` tx). |
| `Games-Labs-Order` handlers/services | Map the enforcement failures to clear, distinct error codes (per-player-limit vs per-day-limit vs total-quota). |
| `shared-lib` / api-gateway | Only if a new error code or field must surface to mobile; verify the redeem contract first. |
| `ai-dev-office` | Track PM scope, implementation evidence, verification. |

## Product Contract (enforcement semantics)

1. **Unlimited redemptions** — no per-user gate (current behavior for the
   per-user dimension); only `total_quota` applies.
2. **One-time use only** — a user may hold at most 1 redeemed row for this item
   (lifetime). Second redeem → reject.
3. **Limited to one claim per day per player** (stored value; legacy `Daily limit`)
   — a user may redeem at most `limit_day_per_player` times per calendar day for
   this item (define the day boundary + timezone explicitly; confirm against how
   other per-day counters in Order are computed).
4. **Per-day item quota** (`is_quota_limit_per_day` + `quota_limit_per_day`) —
   at most N redemptions of this item across ALL users per day.
5. All checks run inside the existing `FOR UPDATE` transaction to stay
   concurrency-safe alongside the `total_quota` guard.

## Acceptance Criteria

- [ ] `RedeemRedemptionItem` rejects a second redeem for `One-time use only`.
- [ ] `RedeemRedemptionItem` rejects redeems beyond `limit_day_per_player` per
      user per day for `Daily limit`.
- [ ] Per-day item quota (`quota_limit_per_day`) is enforced when
      `is_quota_limit_per_day` is set.
- [ ] Each rejection returns a distinct, documented error (not reusing the
      generic "redemption item quota exceeded" for user-level failures).
- [ ] Day boundary / timezone for per-day counting is documented and matches
      existing Order conventions.
- [ ] Unit tests cover: one-time second-claim reject, daily-limit boundary,
      per-day item-quota boundary, and that `Unlimited` is unaffected.
- [ ] No regression to the existing `total_quota` guard or idempotency-key replay.
- [ ] Once shipped, the TASK-EAR-086 Backoffice UI copy is revisited to drop the
      "config-only / not yet enforced" framing.

## Out Of Scope

- Backoffice UI changes (owned by TASK-EAR-086).
- Gift redemption quota rework.

## Assignment

- Primary: `dev`
- Parallel: `false`

Reason: concentrated in the Order redeem repository + error mapping; contract
verification before any shared-lib/gateway change.

## Verification Plan

- Source: re-confirm no other layer already enforces these before adding.
- Tests: table-driven repo tests for each condition + concurrency (two redeems
  racing on the same user under `FOR UPDATE`).
- Command: `go build ./...`, `go test ./...` in `Games-Labs-Order`;
  `ruby ai-dev-office/validate-yaml.rb TASK-EAR-087`.

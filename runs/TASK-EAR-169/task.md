# TASK-EAR-169 — Player Mission complete and auto-credit

## Type

feature

## Workstream

backend

## Priority

high

## Created

2026-07-29

## Objective

Make the Player Edit Missions tab an honest read-progress/admin-completion
surface. Keep the visible `Update` label, remove the non-functional progress
steppers, and make each selected admin force-complete operation automatically
credit the configured Daily or Monthly reward exactly once.

## Scope

- `Games-Labs-Missions`: admin-only force-complete + optional auto-credit,
  stable idempotency, payout result fields, focused tests, and service docs.
- `Games-Labs-backoffice`: read-only progress cards, retained `Update` label,
  auto-credit request, and accurate per-item/partial-failure feedback.
- Existing route remains `POST /api/v1/admin/missions/force-complete` and its
  `google.protobuf.Struct` transport remains backward compatible.

## Acceptance criteria

- Mission progress is read-only; no visible or enabled `+/-` controls remain.
- The primary action still reads `Update`; a source comment records that it
  means “mark selected missions complete.”
- Force-complete requires an admin/superadmin caller for Daily and Monthly.
- `claim_reward=true` completes and credits the configured reward; omitted or
  false retains completion-only compatibility.
- Daily payout reuses the canonical Daily claim rules and stable Wallet
  idempotency.
- Monthly payout uses a stable per-user/per-month Wallet idempotency key and
  can retry after Wallet or persistence failure without double credit.
- The response distinguishes completion and reward outcomes and includes the
  credited amount/currency when available.
- Multi-select UI reports complete success and partial failures honestly, then
  reloads the user's mission overview.
- Focused backend tests, full relevant Go tests, Backoffice tests/build, and
  task YAML validation pass.

## Plan

1. Extend the existing request model and handler without changing the route or
   protobuf transport.
2. Reuse `ForceCompleteDailyMission` + `ClaimDailyMission`; harden retry state.
3. Add a result-returning, idempotent Monthly claim path while preserving the
   existing public claim method.
4. Remove the Backoffice stepper affordance and send `claim_reward=true`; the
   server derives the scoped stable operation key.
5. Add regression tests for authorization, payout, idempotent retry, and UI
   request/render behavior; update service/API documentation.

## Risks

- Duplicate wallet credit on retry or concurrent requests. Mitigation: stable
  Wallet idempotency keys and retryable persistence semantics.
- Partial batch success. Mitigation: one request per selected mission and
  explicit per-item result/error feedback.
- Breaking old force-complete callers. Mitigation: keep the route and existing
  completion-only behavior when `claim_reward` is absent.

## Out of scope

- Weekly/event force-complete.
- Changing mission reward configuration or Wallet ledger rules.
- Deployment or authenticated staging mutation.

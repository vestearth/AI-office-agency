# TASK-033: Wire Daily Activities producers to verified final-state settlement hooks

Epic: Missions Daily Activities v1

Parent: TASK-029

Type: feature

Priority: high

Created At: 2026-04-24

## Scope

### Target Services

- `Games-Labs-Order` -- already has the spend producer path and producer seam, and must finish `turnover.*` producer emission only after TASK-032 confirms the final-state owner hooks.
- `Games-Labs-Game` -- already has canonical round producer helpers/tests, and must wire `round.*` emission only after TASK-032 confirms the runtime settlement/rollback source path.
- `shared-lib` -- remains the frozen source of truth for `player.activity.v1`; producer work must continue to reuse it without service-local drift.

### Affected Files

- `Games-Labs-Order/configs/config.go` (modify if needed) -- keep player-activity publisher settings aligned with the final producer path.
- `Games-Labs-Order/cmd/main.go` (modify if needed) -- keep publisher wiring aligned with the final runtime hook path.
- `Games-Labs-Order/infrastructures/rabbitmq.go` (modify if needed) -- publish canonical `player.activity.v1` payloads using shared topic/version policy.
- `Games-Labs-Order/internal/core/ports/adapters.go` (modify if needed) -- expose producer seams needed by the final runtime hook integration.
- `Games-Labs-Order/internal/core/services/ordersvc/player_activity.go` (modify) -- map turnover settle/reverse payloads to the frozen contract with deterministic ids, reverse references, settlement timestamps, and promotional flags.
- `Games-Labs-Order/internal/core/services/ordersvc/service.go` (modify) -- call producer logic only from verified final-state transitions, preserving the already-landed spend path.
- `Games-Labs-Order/internal/core/services/ordersvc/service_test.go` (modify) -- cover turnover producer behavior and any remaining idempotency-sensitive final-state cases.
- `Games-Labs-Game/configs/config.go` (modify if needed) -- keep player-activity publisher settings aligned with runtime round emission.
- `Games-Labs-Game/cmd/main.go` (modify if needed) -- keep publisher wiring aligned with the runtime round hook path.
- `Games-Labs-Game/infrastructures/rabbitmq.go` (modify if needed) -- publish canonical `player.activity.v1` payloads using shared topic/version policy.
- `Games-Labs-Game/internal/core/ports/adapters.go` (modify if needed) -- expose producer seams needed by runtime round emission.
- `Games-Labs-Game/internal/core/services/gamesvc/player_activity.go` (modify) -- keep canonical round event builders aligned with shared-lib while wiring them to the verified runtime hook.
- `Games-Labs-Game/internal/core/services/gamesvc/service.go` (modify) -- call round producer logic from the verified persisted settlement and rollback/correction transitions delivered by TASK-032.
- `Games-Labs-Game/internal/core/services/gamesvc/player_activity_test.go` (modify) -- cover final round producer emission from runtime-owned behavior.
- `shared-lib/events/player_activity.go` (modify only if an integration-discovered contract defect is proven) -- remain the canonical contract source, with no service-local variants.
- `ai-dev-office/runs/TASK-033/task.md` (create) -- PM blueprint for the producer-wiring child task.
- `ai-dev-office/runs/TASK-033/status.yaml` (create) -- initialized workflow state for the blocked downstream task.
- `ai-dev-office/runs/TASK-033/pm-output.yaml` (create) -- structured PM handoff for downstream producer completion.

## Description

This task finishes the producer side of Daily Activities v1 after TASK-032 makes
the missing runtime settlement hooks real. It should preserve the already-landed
Order spend producer behavior, then wire `turnover.*` and `round.*` emission only
to verified final-state owner transitions. The contract remains frozen in
`shared-lib`, and no speculative request-time or helper-only producer triggers
are allowed.

## Acceptance Criteria

- Producer payloads published from `Games-Labs-Order` and `Games-Labs-Game` match `shared-lib/events/player_activity.go` exactly, including topic/version constants and explicit reverse semantics.
- `Games-Labs-Order` preserves the existing final-state `spend.settled` and `spend.reversed` behavior and additionally emits `turnover.settled` / `turnover.reversed` only from verified final-state owner transitions delivered by TASK-032.
- `Games-Labs-Game` emits `round.settled` and `round.reversed` only from verified persisted settlement and rollback/correction transitions delivered by TASK-032.
- Promotional/free-spin activity remains explicitly flagged in emitted payloads for all producer paths in scope.
- Automated tests cover forward, reverse, promotional, and event-reference behavior for every producer path wired in scope.

## Plan

### Approach

Use TASK-028 as the sole contract authority and TASK-032 as the runtime-owner
prerequisite. Keep the already-landed publisher seam pattern, but attach it only
to verified final-state turnover and round hooks. Preserve existing spend
behavior where it is already correct, and do not broaden producer scope beyond
contract-owned final transitions.

### Subtasks

1. `dev-2` -- Reconcile the landed Order and Game producer seams against the final runtime hooks delivered by TASK-032.
2. `dev-2` -- Wire `turnover.settled` / `turnover.reversed` and `round.settled` / `round.reversed` only from verified final-state transitions, preserving shared-lib payload parity.
3. `dev-2` -- Expand focused producer tests so all in-scope producer families are covered for forward, reverse, promotional, and event-reference behavior.

### Risks And Mitigations

- **Risk:** TASK-032 may reveal that one or both owner transitions live outside current repo scope.
  **Mitigation:** keep this task blocked until ownership is confirmed rather than reintroducing speculative producer triggers.
- **Risk:** existing Order spend behavior could regress while turnover and round wiring are added.
  **Mitigation:** preserve spend tests and explicitly treat existing final-state spend emission as a non-regression requirement.
- **Risk:** producer payload drift may reappear between services.
  **Mitigation:** treat `shared-lib/events/player_activity.go` as the only canonical contract and keep tests asserting parity.

Estimated Complexity: high

## Assignment

- Primary: `dev-2`
- Parallel: `false`
- Reason: this remains cross-service producer integration work tied to contract parity and final-state runtime ownership.

## Summary

TASK-033 is the downstream producer-completion task that follows TASK-032. It
finishes turnover and round Daily Activities emission on top of verified runtime
hooks while preserving the contract-frozen, final-state-only behavior required
for Daily Activities v1.

## Blockers

- `TASK-032` must complete first so turnover and round producers have a verified final-state owner path to attach to.

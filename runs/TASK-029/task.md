# TASK-029: Implement Daily Activities event producers for settled gameplay and spend

Status: Superseded by PM split on 2026-04-24

PM Decision:

- Keep the already-identified producer work as a separate downstream stream.
- Split the missing runtime settlement ownership work into a dedicated prerequisite task.
- Route follow-up execution through `TASK-032` and `TASK-033` instead of continuing to loop on this combined scope.

Replacement Tasks:

- `TASK-032` -- Implement runtime settlement ownership hooks for turnover and rounds.
- `TASK-033` -- Wire Daily Activities producers to verified final-state settlement hooks.

Epic: Missions Daily Activities v1

Parent: TASK-027

Type: feature

Priority: high

Created At: 2026-04-22

## Scope

### Target Services

- `Games-Labs-Order` -- owns `spend.*` by current implementation and remains the TASK-028 owner for `turnover.*`; producer work must stay on final settled/refund transitions only.
- `Games-Labs-Game` -- owns `round.*` per TASK-028 and already has publisher helpers/tests, but still needs a real runtime settle/rollback hook or explicit re-scope.
- `shared-lib` -- remains the frozen source of the canonical `player.activity.v1` contract; producers must reuse it without service-local drift.

### Affected Files

- `Games-Labs-Order/configs/config.go` (modify) -- keep/configure the player-activity queue settings used by the producer adapter.
- `Games-Labs-Order/cmd/main.go` (modify) -- wire the RabbitMQ player-activity publisher into the service startup path.
- `Games-Labs-Order/infrastructures/rabbitmq.go` (modify) -- publish the canonical `player.activity.v1` payload with the shared topic/version policy.
- `Games-Labs-Order/internal/core/ports/adapters.go` (modify) -- expose the producer port used by service code.
- `Games-Labs-Order/internal/core/services/ordersvc/player_activity.go` (modify) -- map settled spend/turnover and reverse events to the TASK-028 contract, including deterministic ids, reverse references, settlement timestamps, and promotional flags.
- `Games-Labs-Order/internal/core/services/ordersvc/service.go` (modify) -- invoke producer logic only from real final-state transitions such as successful fulfillment, refunds, and any true turnover-finalization path that exists in scope.
- `Games-Labs-Order/internal/core/services/ordersvc/service_test.go` (modify) -- cover forward, reverse, promotional, and idempotency-sensitive producer behavior.
- `Games-Labs-Game/configs/config.go` (modify) -- keep/configure player-activity queue settings for the Game producer.
- `Games-Labs-Game/cmd/main.go` (modify) -- wire the RabbitMQ player-activity publisher into Game startup.
- `Games-Labs-Game/infrastructures/rabbitmq.go` (modify) -- publish the canonical `player.activity.v1` payload with the shared topic/version policy.
- `Games-Labs-Game/internal/core/ports/adapters.go` (modify) -- expose the producer port used by service code.
- `Games-Labs-Game/internal/core/services/gamesvc/player_activity.go` (modify) -- keep the canonical round event builders and connect them to the real settle/reverse runtime flow when that flow is confirmed in scope.
- `Games-Labs-Game/internal/core/services/gamesvc/service.go` (modify) -- inject and call round producer logic from the actual owning settlement/rollback transition rather than helper-only code.
- `Games-Labs-Game/internal/core/services/gamesvc/player_activity_test.go` (modify) -- cover settled, reverse, and promotional round emission from runtime-owned behavior.
- `shared-lib/events/player_activity.go` (modify only if a contract defect is proven during integration) -- reuse the frozen contract from TASK-028; do not invent service-local variants.
- `ai-dev-office/runs/TASK-029/task.md` (modify) -- refresh the PM blueprint to match the reviewed codebase state.
- `ai-dev-office/runs/TASK-029/status.yaml` (existing) -- preserve workflow state managed by the orchestrator/reviewer pipeline.
- `ai-dev-office/runs/TASK-029/pm-output.yaml` (modify) -- refresh the structured PM handoff payload.

## Description

Implement the producer side of Daily Activities v1 using the frozen TASK-028 contract and the actual final-state ownership paths present in this repo. The current codebase already contains canonical publisher seams in both target services, a working `Games-Labs-Order` spend producer path, and Game-side round helper/tests. The remaining work is to finish end-to-end runtime emission only where a real settled owner transition exists, prevent producer-specific payload drift, and explicitly block or re-scope any contract-owned event family that still lacks a source-of-truth hook in this repository.

## Acceptance Criteria

- Producer payloads published from `Games-Labs-Order` and `Games-Labs-Game` match `shared-lib/events/player_activity.go` exactly, including topic/version constants and explicit reverse semantics.
- `Games-Labs-Order` emits `spend.settled` only after fulfilled purchase orders become final and emits `spend.reversed` only for final refunded corrections with `reverse_of_event_id` pointing to the counted forward event.
- `Games-Labs-Order` emits `turnover.settled` and `turnover.reversed` only from a real settled gameplay-turnover owner path defined by TASK-028; request-time or speculative hooks do not satisfy the task.
- `Games-Labs-Game` emits `round.settled` and `round.reversed` from a real persisted settlement/rollback transition in production code; helper methods and unit tests alone are not sufficient.
- Promotional/free-spin activity remains explicitly flagged in emitted payloads for both Order and Game producers.
- Automated tests cover forward, reverse, promotional, and event-reference behavior for every producer path that is wired in scope.

## Plan

### Approach

Use TASK-028 as the sole authority for schema, ownership, topic, and version policy. Preserve the publisher seam pattern already landed in both services, but only connect emission to business transitions that are demonstrably final. Do not fabricate producer behavior from pending/request-time flows just to satisfy the checklist. If the repository lacks the true owner transition for `turnover.*` or `round.*`, stop and escalate the missing source-of-truth path instead of introducing ambiguous or early events.

### Subtasks

1. `dev-2` -- Audit the landed Order and Game publisher seams against TASK-028 and keep the current spend producer path aligned to the frozen contract, including any replay/idempotency expectations for already-fulfilled `ConfirmPayment` calls.
2. `dev-2` -- Implement or locate the real Order-owned turnover finalization path and wire `turnover.settled` / `turnover.reversed` there with deterministic ids, reverse references, and settlement timestamps.
3. `dev-2` -- Integrate the Game round publisher helpers into the actual runtime settlement and rollback path; if no such path exists in `Games-Labs-Game`, stop and escalate a PM/orchestrator scope correction rather than merging helper-only coverage as complete.
4. `dev-2` -- Expand focused producer tests in both services so forward, reverse, promotional, and source-reference behavior are locked before Missions consumption rolls out.

### Risks And Mitigations

- **Risk:** `Games-Labs-Game` may not actually own runtime round settlement in this repository.
  **Mitigation:** verify the owning transition before implementation; if the source of truth is elsewhere, split or re-scope the task instead of shipping dead helper code.
- **Risk:** the scoped Order service may still lack a stable settled-turnover finalization hook or reference data.
  **Mitigation:** add explicit correlation plumbing where the owner path exists; otherwise keep the task blocked and raise the gap instead of inferring turnover from non-final data.
- **Risk:** replaying `ConfirmPayment` for an already fulfilled order can republish the same deterministic event.
  **Mitigation:** document and test the intended idempotency behavior, and only add guards if product semantics require at-most-once publication rather than consumer-side dedupe.

Estimated Complexity: high

## Assignment

- Primary: `dev-2`
- Parallel: `false`
- Reason: the work is cross-service, tied to contract ownership, and now includes scope validation around missing final-state hooks.

## Summary

TASK-029 is no longer a generic producer implementation brief. The reviewed codebase shows that Order spend emission is partially landed, Game round publishing is only helper-level today, and the remaining acceptance criteria depend on locating real turnover and round settlement owners. Dev-2 should finish only the verified final-state producer paths and escalate any missing owner hooks instead of inventing them.

## Blockers

- `Games-Labs-Order` still needs a confirmed in-scope finalization path for `turnover.settled` / `turnover.reversed`; the current reviewed code only proves `spend.*`.
- `Games-Labs-Game` currently exposes helper builders/tests but no discovered production settlement or rollback path that calls them.
- If either owner transition lives outside these repositories or outside the scoped services, TASK-029 needs a PM/orchestrator scope correction before it can be closed as complete.

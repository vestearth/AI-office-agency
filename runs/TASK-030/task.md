# TASK-030: Integrate Missions consumer for Daily Activities event flow

Epic: Missions Daily Activities v1

Parent: TASK-027

Type: feature

Priority: high

Depends On:
- TASK-028

Target Services:
- Games-Labs-Missions
- shared-lib

Target Files:
- Games-Labs-Missions/infrastructures/rabbitmq.go (modify) -- bind queues/topics for the approved Daily Activities contract.
- Games-Labs-Missions/internal/services/mission_service.go (modify) -- map canonical events into Daily Activities progress updates, idempotency, and reverse application.
- Games-Labs-Missions/internal/repositories/mission_repo.go (modify) -- persist consumer-side source tracking, progress mutations, and reversal safety.
- Games-Labs-Missions/internal/services/daily_activity*_test.go (modify/create) -- add integration-style tests around mapping, duplicates, and reverse application.
- shared-lib/events/player_activity.go (modify if TASK-028 finalizes changes) -- keep consumer mapping aligned with the frozen contract.
- ai-dev-office/runs/TASK-030/task.md (created) -- PM blueprint for consumer integration.
- ai-dev-office/runs/TASK-030/status.yaml (created) -- initialized workflow state.
- ai-dev-office/runs/TASK-030/pm-output.yaml (created) -- structured PM handoff payload.

Overview:
Integrate Missions as the consumer of the approved Daily Activities event flow. This task wires topic bindings, event mapping, idempotent progress application, and reverse correction support so the umbrella Daily Activities rollout can evaluate progress from asynchronous source events instead of manual or implicit updates.

Objectives:
1. Bind Missions to the approved topic/version from TASK-028.
2. Map canonical forward events into Daily Activities progress updates.
3. Apply reverse events idempotently for rollback/cancel/refund correction.
4. Add integration-level tests around duplicate delivery, reorder risk, and `Asia/Bangkok` day handling.

Acceptance Criteria:
- Missions subscribes to the approved Daily Activities topic/version and ignores unsupported versions safely.
- Forward events update the correct Daily Activities progress rows according to the TASK-027 v1 rules.
- Reverse events subtract previously counted progress idempotently and do not over-apply on retries.
- Consumer processing stores enough source-event metadata to prevent duplicate application.
- Tests cover duplicate delivery, reverse replay, promotional exclusion, and `Asia/Bangkok` `00:00` reset behavior.
- TASK-030 can begin with a skeleton after TASK-028 is stable, but final verification requires producer-compatible payloads.

Test Plan:
1. Feed canonical forward events into the Missions consumer and verify progress rows update as expected.
2. Replay the same event and verify progress does not duplicate.
3. Feed reverse events referencing prior forward events and verify decrements apply once only.
4. Feed events around `Asia/Bangkok` midnight and verify day partitioning/reset behavior.

Risks and Mitigations:
- Consumer may be implemented before producers are ready and drift from real payloads.
  - Mitigation: use TASK-028 fixtures/examples as the single test input source and keep final signoff behind producer-compatible tests.
- Reverse handling can become stateful in fragile ways.
  - Mitigation: persist source application metadata explicitly and make reverse processing reference prior applied events.
- Queue binding/version rollout may break old traffic unexpectedly.
  - Mitigation: ignore unsupported versions safely and document rollout sequencing.

Assigned Agent: dev-2

Reviewer Focus:
- Confirm Missions consumer logic is contract-driven, not coupled to guessed producer internals.
- Confirm idempotency and reverse application are persisted, not just in-memory.

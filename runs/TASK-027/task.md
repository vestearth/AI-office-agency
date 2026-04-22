# TASK-027: Coordinate Daily Activities v1 umbrella integration

Epic: Missions Daily Activities v1

Type: feature

Priority: high

Depends On:
- None

Target Services:
- Games-Labs-Missions
- shared-lib
- api-gateway
- Games-Labs-Order
- Games-Labs-Game

Target Files:
- ai-dev-office/runs/TASK-027/task.md (created) -- PM blueprint for umbrella sequencing and integrated acceptance.
- ai-dev-office/runs/TASK-027/status.yaml (created) -- initialized workflow state.
- ai-dev-office/runs/TASK-027/pm-output.yaml (created) -- structured PM handoff payload.

Overview:
Use TASK-027 as the umbrella/integration epic for Daily Activities v1. This task owns the locked product baseline, cross-task sequencing, and final definition-of-done across contract freeze, producer implementation, Missions consumer integration, and backoffice/API specification. Direct implementation should live in child tasks rather than be duplicated here. The business baseline for v1 remains fixed: `Asia/Bangkok` day boundaries with reset at `00:00` local time, settled turnover only, round count only after round settle, cancel/refund/rollback excluded unless delivered as reverse events that must subtract prior progress, promotional play such as free spins excluded, claim limit 1 per user per activity per day, and no multi-condition AND logic inside a single activity.

Objectives:
1. Freeze the Daily Activities v1 business rules and keep all child tasks aligned to the same baseline.
2. Sequence the work so contract freeze happens first, then producer, consumer, and backoffice outputs land without drift.
3. Define the final integrated outcome for Daily Activities v1 across all child tasks.
4. Keep the design backward-compatible with future milestone/multi-condition expansion without implementing v2 now.

Acceptance Criteria:
- TASK-028 freezes the canonical Daily Activities event contract, ownership matrix, and topic/version policy.
- TASK-029 implements producer behavior against the frozen TASK-028 contract.
- TASK-030 integrates Missions consumer behavior against the frozen TASK-028 contract and producer-compatible payloads.
- TASK-031 defines the backoffice/API form specification aligned with TASK-028 and the v1 rules.
- The integrated v1 baseline remains unchanged across all child tasks: `Asia/Bangkok` reset at `00:00`, settled-only counting, promotional exclusion, reverse support, one claim per day, and one condition per activity.

Test Plan:
1. Validate TASK-028 before starting downstream implementation tasks.
2. Validate TASK-029 and TASK-031 can proceed in parallel once TASK-028 draft is approved.
3. Validate TASK-030 consumes the same canonical contract and passes final integration checks once producer-compatible payloads exist.
4. Validate the end-to-end v1 baseline remains consistent across all child-task outputs.

Risks and Mitigations:
- Child tasks can drift from one another if the contract or v1 baseline is reinterpreted mid-stream.
  - Mitigation: treat TASK-028 as the upstream contract freeze and keep TASK-027 as the umbrella reference point only.
- Work can collide if umbrella scope overlaps implementation scope.
  - Mitigation: keep direct implementation in TASK-029, TASK-030, and TASK-031 and use TASK-027 only for integrated acceptance and sequencing.

Assigned Agent: dev-2

Reviewer Focus:
- Confirm TASK-027 behaves as an umbrella/integration epic, not a duplicate implementation task.
- Confirm child-task outputs remain aligned to the same frozen v1 baseline.

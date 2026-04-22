# TASK-029: Implement Daily Activities event producers for settled gameplay and spend

Epic: Missions Daily Activities v1

Parent: TASK-027

Type: feature

Priority: high

Depends On:
- TASK-028

Target Services:
- Games-Labs-Order
- Games-Labs-Game
- shared-lib

Target Files:
- Games-Labs-Order/**/* (modify) -- emit canonical settled turnover, spend, refund, and rollback events according to TASK-028 contract where Order owns the source of truth.
- Games-Labs-Game/**/* (modify) -- emit canonical settled round and gameplay metadata events according to TASK-028 contract where Game owns the source of truth.
- shared-lib/events/player_activity.go (modify if required by final contract) -- consume the frozen contract from TASK-028.
- Games-Labs-Order/**/*_test.go (modify/create) -- add producer tests for forward and reverse event emission.
- Games-Labs-Game/**/*_test.go (modify/create) -- add producer tests for settled round/promotional/reverse emission.
- ai-dev-office/runs/TASK-029/task.md (created) -- PM blueprint for producer implementation.
- ai-dev-office/runs/TASK-029/status.yaml (created) -- initialized workflow state.
- ai-dev-office/runs/TASK-029/pm-output.yaml (created) -- structured PM handoff payload.

Overview:
Implement the producer side of the Daily Activities v1 event flow after the canonical contract from TASK-028 is approved. This task wires Order and/or Game to emit settled, promotional, and reverse events with the exact fields Missions needs, without leaving producer-specific shape drift in the system.

Objectives:
1. Emit settled forward events from the correct source services per the ownership matrix.
2. Emit reverse correction events for cancel/refund/rollback cases using contract-defined references.
3. Include promotional flags and metadata so Missions can exclude v1 free-spin/promotional activity.
4. Lock producer tests so contract regressions are caught before consumer rollout.

Acceptance Criteria:
- Producer services emit the TASK-028 canonical event contract without service-specific field drift.
- Settled turnover, round settle, and spend-related events are emitted by the owning service(s) only after the relevant activity is final.
- Cancel/refund/rollback paths emit reverse events or correction events that reference the original counted source as defined in TASK-028.
- Promotional activity is flagged explicitly in emitted events.
- Automated tests cover both forward and reverse emission behavior plus promotional flags.
- Topic names and versions match the policy frozen in TASK-028.

Test Plan:
1. Execute unit/integration tests for forward settled events from each owning producer.
2. Exercise refund/rollback flows and verify reverse payloads are emitted with correct references.
3. Exercise promotional/free-spin flows and verify emitted payloads are flagged for exclusion.

Risks and Mitigations:
- Ownership may still be split unclearly across Order and Game services.
  - Mitigation: implement only against the TASK-028 ownership matrix; escalate any mismatch rather than improvising.
- Producers may emit too early before settlement is final.
  - Mitigation: anchor emission at final state transitions only and cover with tests.
- Reverse references may be missing in existing persistence.
  - Mitigation: add correlation/idempotency plumbing where needed during producer implementation.

Assigned Agent: dev-2

Reviewer Focus:
- Confirm producers emit only after settled/final transitions.
- Confirm reverse events are real correction events, not negative forward events with ambiguous semantics.

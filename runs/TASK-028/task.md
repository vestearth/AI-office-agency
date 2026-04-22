# TASK-028: Define Daily Activities event contract, ownership, and topic policy

Epic: Missions Daily Activities v1

Parent: TASK-027

Type: investigation

Priority: high

Depends On:
- None

Target Services:
- shared-lib
- Games-Labs-Order
- Games-Labs-Game
- Games-Labs-Missions

Target Files:
- shared-lib/events/player_activity.go (modify) -- define the canonical Daily Activities source event structure.
- shared-lib/README.md (modify if needed) -- document event ownership, versioning, and field semantics.
- ai-dev-office/runs/TASK-028/task.md (created) -- PM blueprint for contract definition work.
- ai-dev-office/runs/TASK-028/status.yaml (created) -- initialized workflow state.
- ai-dev-office/runs/TASK-028/pm-output.yaml (created) -- structured PM handoff payload.

Overview:
Define the canonical event contract and operational ownership for Daily Activities v1 before producer and consumer implementation begins. This task must produce a stable schema, ownership matrix, and topic/version policy covering settled events, reverse events, promotional flags, event ids, timestamps, timezone assumptions, and which service owns emitting each event type.

Objectives:
1. Freeze the canonical source event schema for Daily Activities v1.
2. Clarify ownership of emitted fields and event responsibilities across Order, Game, and Missions-related domains.
3. Set topic naming, versioning, and compatibility policy to avoid producer/consumer drift.
4. Explicitly encode `Asia/Bangkok` reset semantics and timestamp expectations in the contract notes.

Acceptance Criteria:
- A canonical Daily Activities event schema exists with required fields for event id, user id, event type, settled amount or round unit, game id, game type, promotional flag, reverse reference, occurred-at timestamp, and source service metadata.
- The contract defines which events represent forward progress versus reverse correction for cancel/refund/rollback cases.
- The contract explicitly states that day-boundary evaluation uses `Asia/Bangkok` with reset at `00:00` local time, while event timestamps remain unambiguous for conversion.
- A topic/version policy is documented, including how additive changes are handled and when a breaking change requires a new version.
- An ownership matrix names which service is responsible for producing each event type and which service consumes it.
- Risks or unknowns that block producer/consumer implementation are listed explicitly.

Test Plan:
1. Review current shared event definitions and confirm the final schema covers all four v1 condition types.
2. Validate that every required Missions rule has a source field or derived mapping from the contract.
3. Confirm producer and consumer owners agree on the topic name and versioning policy before implementation tasks proceed.

Risks and Mitigations:
- Existing producers may emit similar but non-identical event shapes today.
  - Mitigation: publish one canonical schema and require producers to align rather than allowing per-service variants.
- Timestamp semantics may remain ambiguous between event time and settle time.
  - Mitigation: define a required settled-at field or one clearly named canonical timestamp for Daily Activities evaluation.
- Versioning may be skipped under delivery pressure and create hidden breakage later.
  - Mitigation: document explicit compatibility rules now and gate downstream tasks on this output.

Assigned Agent: dev-2

Reviewer Focus:
- Confirm the output is a real contract package, not just a code stub.
- Confirm ownership and versioning are explicit enough for `TASK-029`, `TASK-030`, and `TASK-031` to proceed without re-deciding fundamentals.

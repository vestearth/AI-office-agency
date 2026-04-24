# TASK-032: Implement runtime settlement ownership hooks for turnover and rounds

Epic: Missions Daily Activities v1

Parent: TASK-029

Type: feature

Priority: high

Created At: 2026-04-24

## Scope

### Target Services

- `Games-Labs-Order` -- must expose the real final-state turnover settlement/reversal transition instead of leaving producer code to infer completion from request-time or unrelated order flows.
- `Games-Labs-Game` -- must expose the real persisted round settlement and rollback/correction transition so downstream Daily Activities producers can attach to a source-of-truth runtime path.

### Affected Files

- `Games-Labs-Order/internal/core/services/ordersvc/service.go` (modify) -- add or surface the true turnover-owned finalization and reversal hook in production code.
- `Games-Labs-Order/internal/core/ports/repositories.go` (modify if needed) -- expose any repository methods required to persist or retrieve turnover finalization state safely.
- `Games-Labs-Order/internal/core/ports/services.go` (modify if needed) -- expose any domain service seams needed for turnover finalization ownership.
- `Games-Labs-Order/internal/core/services/ordersvc/service_test.go` (modify) -- cover final-state turnover settle/reverse behavior at the owning transition.
- `Games-Labs-Game/internal/core/services/gamesvc/service.go` (modify) -- implement or surface the persisted round settlement and rollback/correction transition that owns runtime completion.
- `Games-Labs-Game/internal/core/ports/repositories.go` (modify if needed) -- expose repository methods required by the round settlement/rollback source-of-truth path.
- `Games-Labs-Game/internal/core/ports/services.go` (modify if needed) -- expose domain seams needed to model round finalization ownership in service code.
- `Games-Labs-Game/internal/core/services/gamesvc/player_activity_test.go` (modify if needed) -- keep helper-level expectations aligned with the runtime-owned transition once it exists.
- `Games-Labs-Game/internal/core/services/gamesvc/service_test.go` (create if needed) -- add focused tests for settled and reversed round lifecycle behavior in production code.
- `ai-dev-office/runs/TASK-032/task.md` (create) -- PM blueprint for the settlement-hook prerequisite task.
- `ai-dev-office/runs/TASK-032/status.yaml` (create) -- initialized workflow state for the new child task.
- `ai-dev-office/runs/TASK-032/pm-output.yaml` (create) -- structured PM handoff for downstream execution.

## Description

The current repo already has Daily Activities producer helpers and partial producer
seams, but the final runtime owner transitions for `turnover.*` in
`Games-Labs-Order` and `round.*` in `Games-Labs-Game` are still missing. This task
creates or surfaces those production-grade settlement and reversal hooks first.
Its goal is not to publish Daily Activities events yet; its goal is to make the
real business transitions exist in the owning services so downstream producer
work can attach to a verified final-state source of truth.

## Acceptance Criteria

- `Games-Labs-Order` exposes a production turnover finalization path that represents the true counted settled state, not a request-time, speculative, or helper-only transition.
- `Games-Labs-Order` exposes the corresponding reversal/correction path for turnover where product behavior requires it, with enough source references for downstream reverse event linkage.
- `Games-Labs-Game` exposes a persisted production round settlement path owned by runtime business flow rather than helper-only code.
- `Games-Labs-Game` exposes the corresponding round rollback/correction path where product behavior requires it, with enough source references for downstream reverse event linkage.
- Focused automated tests cover the new owning transitions and prove they represent final state.
- No Daily Activities producer payload logic is invented here beyond what is necessary to surface the owner transition; producer wiring remains downstream scope.

## Plan

### Approach

Treat this as the missing domain-runtime prerequisite that TASK-029 could not
skip. First verify what the current services truly own, then implement the
minimum production-grade turnover and round finalization lifecycle needed for
Daily Activities v1. Keep the settlement hooks explicit and testable, and avoid
smuggling producer-specific behavior into domain ownership work beyond the
references needed for downstream attachment.

### Subtasks

1. `dev-2` -- Confirm the actual in-scope owner transition for turnover settlement and reversal in `Games-Labs-Order`, then implement the final-state hook in production code.
2. `dev-2` -- Confirm the actual in-scope owner transition for round settlement and rollback/correction in `Games-Labs-Game`, then implement the runtime hook in production code.
3. `dev-2` -- Add focused tests that prove both services now expose final-state source-of-truth transitions suitable for downstream producer attachment.

### Risks And Mitigations

- **Risk:** the real settlement owner may live outside the currently scoped repositories.
  **Mitigation:** verify ownership before deep implementation; if ownership is truly out of scope, stop and escalate instead of fabricating new domain behavior.
- **Risk:** turnover or round correction semantics may be under-specified for reverse handling.
  **Mitigation:** require tests and source references that make reversal behavior explicit before downstream producer work starts.
- **Risk:** this task could drift into producer implementation again.
  **Mitigation:** keep acceptance focused on domain runtime hooks only and leave event emission to TASK-033.

Estimated Complexity: high

## Assignment

- Primary: `dev-2`
- Parallel: `false`
- Reason: this is cross-service, domain-owning runtime work with non-trivial source-of-truth and reversal semantics.

## Summary

TASK-032 is the prerequisite runtime-ownership task that unblocks the producer
stream. It makes the missing final-state turnover and round lifecycle hooks real
inside the owning services so Daily Activities producer wiring can proceed
without guessing at settlement semantics.

## Blockers

- If turnover settlement ownership is external to `Games-Labs-Order`, PM will need a scope correction instead of an implementation patch in this repo.
- If round settlement ownership is external to `Games-Labs-Game`, PM will need a scope correction instead of an implementation patch in this repo.

# Phase 4 decision: `run-agent.sh auto` remains fully supported

Status: **Phase 4 of [#23](https://github.com/vestearth/AI-office-agency/issues/23)
— decision only, no code changed.** This closes the four-phase refactor.

## The gate, and why this is a decision doc rather than a deprecation

The issue's own Phase 4 text is explicit about its precondition:

> Only after an alternative execution path has proven stable: decide whether
> `run-agent.sh auto` remains supported; move it to legacy/compatibility
> mode; or simplify/remove parts that duplicate the chosen runtime layer.
> This should be a separate explicit decision, not an automatic consequence
> of this refactor.

Phases 1-3 built the boundary and the interfaces (`docs/orchestration-boundary.md`,
`docs/task-transition-contract.md`, `docs/runtime-adapter-contract.md`) that
would let an alternative execution path exist. They did not, and were not
meant to, produce one. The gate is evaluated here against real usage data,
not against whether the interfaces exist.

## The evidence

Queried `runs/TASK-*/status.yaml` directly (392 task directories, spanning
2026-04-03 to 2026-08-21 — this refactor's entire lifetime and considerably
before it):

```
   358 phase: done
    12 phase: in_review
    10 phase: pending
     6 phase: aborted
     2 phase: blocked
     1 phase: devops_complete
     1 phase: assigned
     1 phase: "done"
```

**No alternative *execution path* has been used at all.** Zero task
directories reference Multica, and zero show any external orchestrator
dispatching a role. `grep -rl multica runs/` returns two incidental content
matches (a status note mentioning the word, a planning doc), not a dispatch
record — confirmed by reading both; neither is evidence of Multica having
executed a role for this repo.

**The manual/`cursor`-runner record-import path has proven stable, as a
complement, not a replacement.** 10 task directories carry a
`.cursor-prompt.md` (the artifact `run-agent.sh <TASK_ID> <ROLE> cursor`
writes instead of invoking a subprocess, letting a human do the work in any
tool and the driver re-import the result — see
`docs/task-transition-contract.md`'s "record/import" section). These are
real, successfully completed tasks (9 of 10 reached `phase: done`, one is a
malformed/incomplete `status.yaml` predating this refactor's schema work),
spread across the full date range — `TASK-016`/`TASK-019`/`TASK-023` in
April, `TASK-068` in May, `TASK-EAR-212`/`TASK-EAR-237`/`TASK-EAR-238`/
`TASK-EAR-239`/`TASK-EAR-240` in August. That is genuine stability over
4.5 months, not a one-off experiment. But it is 10 of 392 tasks (2.6%) —
a working fallback for when manual execution is the right call, not a
demonstrated alternative to `auto` as the primary path.

**`run-agent.sh auto`, dispatching through its existing `codex` →
`cursor-agent` → `cursor` runner priority (`office.config.yaml`'s
`runner_selector`), remains how the overwhelming majority of real work in
this repo actually happens.** 358 of 392 tasks (91%) reached `done`; the
runner-selector's own fallback between underlying CLI binaries (codex to
cursor-agent to cursor) is not a Phase-4-relevant "alternative execution
path" — it's `auto`'s own resilience mechanism, unchanged by this refactor,
already exercised by `tests/integration/runner-fallback.sh`.

## Decision

**`run-agent.sh auto` remains fully supported, unchanged, and the primary
local execution path.** It is not moved to legacy/compatibility mode. No
part of it is simplified or removed for duplicating a chosen runtime layer,
because no runtime layer has been chosen — nothing has been adopted that
duplicates it.

This is the first branch of the issue's own three options ("decide whether
`run-agent.sh auto` remains supported"), reached because the gate for the
other two ("only after an alternative execution path has proven stable")
is not met. It is an explicit decision, backed by the usage data above, not
an automatic default reached by skipping the question.

## What would change this decision

Re-open the question if either becomes true:

- An external orchestrator (Multica, or another dispatcher) is actually
  wired up and used to execute roles against real tasks in this repo —
  `docs/runtime-adapter-contract.md` §5 sketches, without implementing,
  what that bridge would look like. At that point, compare its real
  completion rate and reliability against `auto`'s 91% before considering
  any legacy/compatibility move.
- The manual/`cursor` path's share of completed tasks grows enough that it
  is doing more than complementing `auto` — e.g. it becomes the primary
  path for a whole class of work, not an occasional fallback.

Neither is close today. This decision should be treated as current, not
revisited on a schedule — only when one of the above actually happens.

## Disposition of issue #23

All four phases are now resolved:

- Phase 1 (boundary documented) — merged `d96e27f1`.
- Phase 2 (workflow operations extracted) — merged `0f65450f`.
- Phase 3 (runtime-adapter contract formalized) — merged `e0a35bf2`.
- Phase 4 (this decision) — `run-agent.sh auto` remains fully supported;
  no deprecation, no legacy mode, no removal.

The resilience requirement and all eight acceptance criteria in the issue
are satisfied by the combination of Phases 1-4: core task state and
`next_action` work without Multica or Munder (verified throughout, and
Munder was never made a dependency); manual execution is first-class and
proven stable (see the evidence above); `auto` still works as the
standalone fallback (it is the primary path, not merely a fallback);
workflow state carries no required provider/runtime field (`status.yaml`
has none); an external runtime's absence or failure cannot strand
`runs/TASK-*` (nothing depends on one existing); runtime integrations can
be replaced without rewriting PM/reviewer semantics (the contract in
`docs/runtime-adapter-contract.md` is exactly that seam); the workflow
authority/runtime execution boundary is documented (`docs/orchestration-boundary.md`,
`docs/task-transition-contract.md`, `docs/runtime-adapter-contract.md`);
and this document is itself the separate, explicit, evidence-backed
decision the issue required before any deprecation could even be
considered — which concluded no deprecation is warranted.

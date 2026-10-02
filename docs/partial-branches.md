# Partial branches (Issue #28, Phase 1C)

An assigned task may declare independent branches in `status.yaml`. Each
branch records whether its portion is executable, waiting, finished, or no
longer applicable. This is opt-in; tasks without `branches` retain their
existing behavior.

## Shape and meaning

```yaml
phase: assigned
state: assigned
ready: true
branches:
  wave_1:
    state: ready
    actor: pm
    reason: Bank 429 and Redis admission work can proceed
    updated_at: "2026-10-02T00:00:00Z"
  wave_2:
    state: blocked
    actor: pm
    reason: Fairness policy is undecided
    updated_at: "2026-10-02T00:00:00Z"
    waiting_for:
      - "operator: choose fairness policy A/B/C"
```

Branch names use lowercase letters, digits, and underscores, starting with a
letter. Every branch has `state`, `actor`, `reason`, and `updated_at`.
`blocked` also requires at least one `waiting_for` reason. A branch's
`waiting_for` is local: as long as a sibling is `ready`, the task can follow
its normal executable phase, including a dev-to-reviewer handoff. The
task-level `waiting_for` lists blocked branches using the reserved `branch:`
prefix, even while another branch is ready. When no branch is `ready` and at
least one is `blocked`, the task becomes `blocked`. Existing task-level waits
and dependencies remain in place. Resolving the last branch wait restores
`assigned` only when no other task-level wait or dependency remains.

`done` means that branch's work was accepted. `na` means the branch was
explicitly ruled out, with a reason. Neither can be reopened. Every declared
branch must reach `done` or `na` before the task can reach `done`. The common
completion guard enforces this on every supported done writer; the validator
checks stored states too. Completion gates still apply independently.

## Governed updates

Use the writer in any non-terminal task phase, including `review` and
`in_review` after a normal handoff:

```bash
ruby scripts/update-task-branch.rb TASK-VS-004 declare wave_1 --actor pm --reason "Wave 1 can proceed"
ruby scripts/update-task-branch.rb TASK-VS-004 declare wave_2 --actor pm --reason "Policy pending" --state blocked --waiting-for "operator: choose policy A/B/C"
ruby scripts/update-task-branch.rb TASK-VS-004 done wave_1 --actor dev --reason "Wave 1 accepted"
ruby scripts/update-task-branch.rb TASK-VS-004 ready wave_2 --actor pm --reason "Policy A selected"
ruby scripts/update-task-branch.rb TASK-VS-004 done wave_2 --actor dev --reason "Wave 2 accepted"
```

`declare` defaults to `ready` and can start `blocked`. After declaration,
allowed moves are `ready → blocked|done|na` and `blocked → ready|na`.
`block` needs one or more `--waiting-for` values; other moves remove the
branch wait. The writer locks the task, applies the ownership fence, records
the actor/reason/time and a history entry, and emits a `branch_updated`
event. As with completion gates, actor text is recorded but identity is not
authenticated; editing YAML by hand bypasses the writer's history.

`./run-agent.sh status TASK-VS-004` displays each branch and its wait;
`scripts/adapter-status.rb` includes `branches` in machine-readable status.
The shared branch projection is applied after normal output sync, forced
routes, human decision reconciliation, and dependency reconciliation. Stored
state validation checks its branch waits and block state. `escalated` and
`validation_failed` keep their recovery routes; `done` and `aborted` keep
their terminal routes. Branch waits remain visible in those states.

For the TASK-VS-004 replay, move only the existing fairness-policy prose wait
from task-level `waiting_for` into `wave_2.waiting_for` before declaring the
branches. Keep its separate staging multi-merchant approval wait at task level.
The writer deliberately preserves task-level waits because it cannot infer
which old prose item belongs to which branch. The integration test copies the
checked-in status and performs this migration in a temporary run directory;
it does not change the live task record.

Phase 1C records partial progress and computes whether the whole task is
blocked. It does not select a branch for a runner, split agent outputs, grant
authorization, or judge acceptance automatically. The task's existing
`current_agent`, output contract, and completion gates continue to govern
those steps.

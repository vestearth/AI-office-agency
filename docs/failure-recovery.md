# Failure classification and recovery (Issue #28, Phase 1D)

Phase 1D records an explicit judgment about a failed task verification and
routes the next step through existing Office phases. The classifier is the
conductor/operator using source evidence; a failed command or runner exit
does not silently choose a business failure class. Tasks without a
`failure_classified` event keep their existing workflow.

## Classes and routes

| Classification | Recovery action | Default route | Allowed alternate |
|---|---|---|---|
| `implementation_defect` | `debug_fix` | `debugging` / debugger | `assigned` / dev |
| `invalid_assumption` | `replan` | `pending` / pm | `assigned` / dev |
| `environment_runtime` | `diagnose` | `devops_needed` / devops | — |
| `missing_data` | `investigate` | `debugging` / debugger | — |
| `permission_authority` | `escalate` | `blocked` / pm | — |

The two `dev` alternates preserve a focused fix or re-plan in an already
assigned developer lane. A permission/authority classification requires a
specific task-level `waiting_for` reason and makes `ready: false`; it does
not grant the authority. Existing runner fallback handles transient tool
errors with its own bounded retry policy. This table does not replace that
runtime mechanism, the validation-failure retry cap, or execution budget.

## Governed writer

```bash
ruby scripts/classify-task-failure.rb TASK-VS-003 invalid_assumption \
  --actor pm --reason "Production 5xx came from DB lock contention" \
  --history-index 7 \
  --invalidates "The existing lock strategy can sustain the capacity target" \
  --route dev
```

`--actor`, `--reason`, and at least one source are required. A source may be a
zero-based `--history-index` into this task's `status.yaml.history`, one or
more comma-separated `--evidence ev-NNN` ids from its `evidence.yaml`, or
both. `invalid_assumption` requires one or more `--invalidates` statements;
`permission_authority` requires one or more `--waiting-for` statements.
The writer checks the selected route, source, and evidence ids under the
task lock and ownership fence. It refuses terminal tasks. Repeating the same
classification, source, reason, and route is an idempotent no-op.
It also refuses a runnable recovery route while the task is still `blocked`
by a task-level `blocked_on` dependency or a non-branch `waiting_for` reason.
Resolve that block through the existing dependency or human-decision path,
then run the classification command again. Branch-only waits keep their
Phase 1C projection behavior.

The writer appends a normal `status.yaml.history` transition and a structured
`failure_classified` event in `meta.yaml`:

```yaml
type: failure_classified
agent: pm
details: Production 5xx came from DB lock contention
timestamp: "2026-10-02T00:00:00Z"
classification: invalid_assumption
source_history_index: 7
invalidates:
  - The existing lock strategy can sustain the capacity target
recovery:
  action: replan
  from_phase: review
  to_phase: assigned
  to_agent: dev
```

`evidence_refs` may also appear when there are command/artifact evidence ids.
The validator resolves both source forms against this task and checks the
class/action/route shape. Ordinary `meta.yaml` events retain their existing
four-field shape; typed recovery fields are valid only on
`failure_classified` events. `details` stays human-readable, while consumers
can read the structured fields directly. Status and meta writes take the
same task lock and use atomic per-file replacements; the writer attempts to
restore status if the meta write fails. There is no cross-file transaction.

If a task also declares Phase 1C branches, the branch projection is applied
after the selected route. A remaining branch block can keep the effective
task phase `blocked`; the event records that effective phase. Completion
gates and authorization rules still apply to later `done` or privileged
actions.

## Replay boundary

`tests/integration/failure-recovery.sh` copies one actual history reason at a
time from TASK-VS-003 and TASK-VS-006 into temporary replay tasks. VS-003's
production lock-contention finding supports `invalid_assumption → replan`.
VS-006's original PUT/cache defect supports `implementation_defect →
debug_fix`; its later staging hard-reload finding supports a further
`invalid_assumption → replan`. The replay shows how Phase 1D would record and
route those observations. It does not rewrite their historical phases or
claim that the new writer ran in those completed tasks.

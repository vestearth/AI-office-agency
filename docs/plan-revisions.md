# Plan revisions (Issue #28, Phase 2A)

When a task's plan or scope changes mid-run, record it as a **revision**. A
revision is an append-only entry in `status.yaml` that must, in the same
write, either declare the completion gates and branches the change implies or
say why it implies none. It cannot be recorded while silently skipping that
question.

A revision authorizes nothing (`authorization.yaml`), decides nothing
(`decision.yaml`) and adds no completion rule. The gates and branches it
declares are ordinary ones: the existing completion guard, authorization
binding and branch rules give them their teeth.

## Recording one

Replace `TASK-EXAMPLE-NNN` with the id of an open task. The writer refuses a task that is `done` or `aborted`.

```bash
# scope grew into production data work: declare the bound gate now
ruby scripts/revise-task-plan.rb TASK-EXAMPLE-001 scope_expanded --actor dev \
  --reason "operator chose to backfill rows written with the old timezone" \
  --gate production_backfill:production_backfill

# the plan split into an executable and a decision-blocked part
ruby scripts/revise-task-plan.rb TASK-EXAMPLE-002 plan_changed --actor pm \
  --reason "wave 2 waits on the fairness policy" \
  --branch wave_1:ready --branch "wave_2:blocked:operator: fairness policy A/B/C"

# the plan changed but the completion contract did not
ruby scripts/revise-task-plan.rb TASK-EXAMPLE-003 plan_changed --actor dev \
  --reason "second root cause found in staging" \
  --no-new-gates "same files and the same deploy path as the existing gates"
```

- `kind`: `scope_expanded`, `scope_narrowed`, `plan_changed` or `acceptance_changed`. It is a label only; no behaviour depends on it.
- `--gate NAME` declares an unbound gate. `--gate NAME:ACTION` binds it to an authorization action (`deploy_staging deploy_production production_data_mutation production_backfill live_load external_side_effect`).
- `--branch NAME:ready` or `--branch NAME:blocked:TEXT`. Everything after the second colon is the single `waiting_for` entry; add more waits with `update-task-branch.rb`.
- You must pass either at least one `--gate`/`--branch` or `--no-new-gates WHY`, and not both.
- Narrowing is `scope_narrowed --no-new-gates WHY`, followed by `update-completion-gate.rb … na` / `update-task-branch.rb … na` for whatever no longer applies. A revision never resolves a gate or a branch.
- Exits: `0` recorded, or the identical last revision is already recorded (safe to retry). "Identical" means the same kind, actor, reason and effects **and** that each named gate still has the same authorization binding and each named branch the same state (and, when blocked, the same waiting text); anything else is refused as already declared; `2` usage error or refusal (finished task, name already declared, unknown kind/action, an argument that is not valid UTF-8; arguments are read as UTF-8 whatever the locale); `3` unreadable or malformed state; `9` ownership fence.

## What is stored

```yaml
revisions:
  - id: rev-001                 # numeric order, never string order; grows past rev-999
    at: "2026-09-28T08:00:00Z"
    kind: scope_expanded
    actor: dev
    reason: "Operator chose to ship a backfill for rows written with the old timezone"
    effects:
      gates_declared: [production_backfill]
      branches_declared: []
```

The writer also appends status history rows: one per gate and branch, in the existing writers' formats, then `plan revision rev-NNN: <kind>`. It appends a `plan_revised` event to the local `meta.yaml`, which is an informational mirror only. The validator requires that every name in `effects` still exists in `completion_gates` / `branches`.

## Limits

- `actor` and `reason` are unverified free text; `status.yaml` can be hand-edited. Same trust level as gates and branches.
- Nothing detects that the scope changed. A revision exists only if someone records it.
- A recorded revision counts as meaningful activity for the execution-budget no-progress guard.
- Declaring a gate with `update-completion-gate.rb` after work began is still allowed without a revision (deferred; see the spec).

Spec: [`superpowers/specs/2026-10-02-plan-revisions-design.md`](superpowers/specs/2026-10-02-plan-revisions-design.md).

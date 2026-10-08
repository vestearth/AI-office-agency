# Phase 2E — Gate-Aware Roles

**Status:** design, approved in conversation 2026-10-08; pending written-spec review. **Issue:** vestearth/AI-office-agency#28. **Builds on:** Phase 1A–1D and 2A–2D (all merged; main e5966448).

## Summary

Teach the roles to use completion gates. This has three parts.

1. **PM declares gates in its output.** `pm-output.yaml` gains an optional `completion_gates` list, giving each gate's name, reason, `after`, `requires_authorization` and `requires_record`. When PM output is synced, `sync-status-from-output.rb` declares those gates in `status.yaml` itself.
   - It uses the same record and history construction as the governed writer, under the same lock and fence.
   - Reconciliation is **add-only**. A plan that would change or remove anything is refused, and nothing is written.
2. **Every role contract says how to work with gates.** PM, dev, dev-2, devops and reviewer each get a "Completion gates" rule.
3. **The dispatched prompt shows the gates.** It gets a `--- COMPLETION GATES ---` block, rendered with the same text as `run-agent.sh status` (2D).

## Evidence

- **No role is told that gates exist.**
  - None of `agents/*.md`, `templates/`, `role-prompt-templates-codex-first.md`, `AGENTS.md`, `SKILL.md`, `QUICKSTART.md`, `workflows/` or `profiles/` mentions `completion_gates`, `update-completion-gate.rb` or completion gates.
  - The PM output contract (`agents/pm.md`, Output Contract) has nowhere to put them.
- **Gates that do exist were written by hand.** TASK-EAR-384/385's pending gates have no actor and no `updated_at`, which means they bypassed the writer.
- **Nothing from 2A–2D is used.** Across the 519 runs in the main checkout:
  - 0 `revisions`;
  - 0 `after` (the single `after:` hit is prose in TASK-EAR-381);
  - 0 `requires_record`, and 0 `ran`;
  - only 2 tasks with `completion_gates` at all.

  2D made gates visible, but nothing tells a role to create or update them.
- **The plumbing already exists.**
  - The prompt already includes the raw `status.yaml` (`run-agent.sh`, `STATUS_SECTION`).
  - PM output is already applied by `sync-status-from-output.rb` under the task lock and ownership fence.
  - `run-agent.sh` already routes sync exit 3 (malformed output) to `validation_failed`.

## Concepts kept separate

| Concept | Where | 2E change |
|---|---|---|
| Gate rules (resolution, ordering, records, authorization, the `done` guard) | `CompletionGuard`, `update-completion-gate.rb`, validator | none |
| **Planned gates** | `pm-output.yaml` → `completion_gates` | **new field** |
| **Applying the plan** | `sync-status-from-output.rb` (PM output only) | **declares gates, add-only** |
| **What roles are told** | `agents/{pm,dev,dev-2,devops,reviewer}.md` | **a "Completion gates" rule** |
| **What roles see** | `run-agent.sh` prompt assembly | **a `--- COMPLETION GATES ---` block** |
| Gate view text | 2D renderer | **moved to `scripts/gate-status-text.rb`** (same bytes) |

## Non-goals

- Changing the output schemas of dev, dev-2, devops or reviewer (no gate checklist in the reviewer output).
- Inferring gates the PM did not declare.
- Applying gates from any output other than PM's.
- Requiring a 2A revision when gates are added after work began.
- Dashboard UI.
- Backfilling gates into existing runs, including EAR-384/385.

## Design

### 1. `completion_gates` in PM output

The field is optional and is a list in declaration order:

```yaml
completion_gates:
  - name: shared_lib_publication
    reason: "Game and gateway consume the published contract"
    after: [product_contract]                  # optional, non-empty when present
    requires_authorization: deploy_production  # optional, one of AuthorizationLedger::ACTIONS
    requires_record: true                      # optional, only true
```

`validate_pm_output` checks the field on its own. These rules use the stored-gate grammar and messages where they exist:

- the list is a list of maps;
- each entry has `name` (matching `GATE_NAME_PATTERN`) and a non-empty `reason`, plus optional `after`, `requires_authorization` and `requires_record`, and no other keys;
- names are unique;
- `after` is a non-empty list of names that matches the pattern, has no duplicates and does not include the gate itself;
- `requires_authorization` is one of the six actions, and `requires_record` is `true`;
- the `after` relation among the listed gates is acyclic.

Whether an `after` name exists is checked at sync time, because it may name a gate already in `status.yaml`. A PM output without the field validates and syncs exactly as before.

`schemas/pm-output.schema.yaml` documents the field. `tests/integration/schema-validator-parity.sh` pins the field's item keys and the action enum.

### 2. Applying the plan: `sync-status-from-output.rb`

When the synced output is PM's and it has `completion_gates`, the sync reconciles each listed gate in order. This happens inside the existing critical section (task lock, then `TaskOwnership.fence!`), before the single status write. One clock read stamps everything.

| State in `status.yaml` | Result |
|---|---|
| Absent | Declared as `pending` through `CompletionGuard.gate_record`: actor `pm`, the listed reason, `updated_at`, `evidence_refs: []`, plus `requires_authorization` / `after` / `requires_record` when given. History row: `gate <name>: absent -> pending`. |
| Present and equal (same binding, same `after` set, same `requires_record`) | No change. |
| Present, `pending`, and the plan only adds | New `after` names are appended (history row `gate <name>: after += <names>`), and/or `requires_record: true` is set (history row `gate <name>: requires_record`). These are the same rows the writer's `depend` and `require-record` write. |
| Conflict (any of the cases below) | The whole sync is refused with **exit 6** and nothing is written. |

A conflict is any of:

- a different `requires_authorization`, including adding one to a gate that has none;
- an existing `after` name missing from the plan;
- an existing `requires_record` missing from the plan;
- an addition to a gate that is not `pending`;
- an `after` name that is neither listed nor already declared;
- a resulting ordering that fails `CompletionGuard.ordering_errors`, such as a cycle across the plan and `status.yaml`.

**Other rules**

- A gate in `status.yaml` that the plan does not list is left untouched. Gates are never deleted; narrowing uses `na` through the writer.
- History rows and `completion_gate_updated` meta events are written as the writer writes them. They use the agent `event_agent("pm")`, the listed reason and the single clock read.
- The construction is shared with `update-completion-gate.rb`: the declare, `after +=` and `requires_record` record and history-row construction moves into `CompletionGuard` helpers that both use. The writer's output stays byte-identical (pinned by the 2A section W golden and the 2B/2C suites).
- A repeat sync of the same PM output is a no-op for gates. The existing `last_synced_output` idempotency also still applies.
- Exit codes are the existing set plus **6: the gate plan conflicts with `status.yaml`; status.yaml untouched**. The conflict message names the gate and the reason.
- `run-agent.sh` handles sync exit 6 the way it handles exit 3. It routes to `validation_failed` (actor `free-roam`) with the reason `gate plan conflicts with status.yaml: <message>`, records `outcome.validation=failed`, and logs `validation_failed`. PM is therefore re-run with the reason rather than the conflict being silently skipped.

### 3. Role contracts

Each of `agents/pm.md`, `dev.md`, `dev-2.md`, `devops.md` and `reviewer.md` gains a short "Completion gates" rule in its `## Rules` section. All of them point to `docs/completion-gates.md` and the one writer, and say never to hand-edit `completion_gates`.

- **pm:**
  - Declare gates in `completion_gates` for checkpoints that must be met before the task is done, such as publication, merge, deploy, staging smoke, backfill or runtime acceptance.
  - Use `after` for real ordering, `requires_authorization` for actions that need operator approval, and `requires_record` where what ran must be recorded.
  - The PM output contract example shows the field.
- **dev / dev-2:**
  - When work satisfies a gate, `pass` it with `update-completion-gate.rb … pass <gate> --actor <role> --reason … [--ran-by … --ran-ref …/--ran-url …]`.
  - Use `na` with a reason for a gate that no longer applies.
  - Only act on gates shown as `can pass now`.
- **devops:** pass deploy and backfill gates with `--authorization authz-NNN` and a `--ran-*` record (for example, the run URL).
- **reviewer:**
  - Read the `COMPLETION GATES` block before approving.
  - Pass verification gates with the writer.
  - Do not report the task as complete while gates are unresolved. The `done` guard enforces this anyway.

### 4. The prompt block

- In `run-agent.sh` prompt assembly, directly after `--- STATUS ---`, add a `--- COMPLETION GATES ---` block for a task whose `status.yaml` has `completion_gates` or `revisions`.
- The block's lines are exactly those `run-agent.sh status <TASK>` prints for gates and revisions (2D, Design 2), including the unreadable form.
- A task without either key gets a byte-identical prompt.
- A failure to render never fails the dispatch. Rendering is read-only, and on an unexpected error the block reads `Gates: unavailable`.
- To share the text, the 2D renderer methods (`gate_status_lines`, `gate_status_suffix`, `gate_status_part`) move from the `run-agent.sh status` heredoc into `scripts/gate-status-text.rb` (module `GateStatusText`). Both the `status` heredoc and the prompt assembly use it. The `status` output stays byte-identical (pinned by `gate-status.sh`).

### 5. Files

| File | Change |
|---|---|
| `scripts/completion-guard.rb` | shared declare / `after +=` / `requires_record` record and history-row helpers; a `plan_gate_errors` shape check shared by the validator and the sync |
| `scripts/update-completion-gate.rb` | uses the shared helpers (same bytes) |
| `scripts/sync-status-from-output.rb` | PM gate-plan reconciliation, exit 6 |
| `run-agent.sh` | handles exit 6; the prompt block; the `status` heredoc requires `scripts/gate-status-text.rb` |
| `scripts/gate-status-text.rb` | new: the 2D text renderer, moved |
| `validate-yaml.rb`, `schemas/pm-output.schema.yaml` | the PM field |
| `agents/{pm,dev,dev-2,devops,reviewer}.md` | the "Completion gates" rule (and PM's contract example) |
| `tests/integration/pm-gate-plan.sh` | new suite |
| `tests/integration/schema-validator-parity.sh` | pins the PM field |
| `docs/completion-gates.md`, `docs/task-transition-contract.md` | the plan field, the sync rules, exit 6 |

## Tests

New suite `tests/integration/pm-gate-plan.sh`. Each behaviour is seen failing before its implementation.

**Validator:**
- every rule in Design 1 as a case;
- a PM output without the field validates.

**Sync, first plan:**
- An EAR-384-shaped plan with four gates, `after` and `requires_record` is applied in one sync.
- The gates have actor `pm`, `updated_at`, the history rows and meta events.
- The phase transition is the normal PM one (`assigned`).
- `run-agent.sh status` renders the gates with their waits.

**Same as the writer.** The gates the sync writes are byte-identical, timestamps normalized, to the same gates produced by `declare` / `depend` / `require-record` through `update-completion-gate.rb`.

**Repeat sync:**
- The same output is a no-op: `status.yaml` is byte-identical apart from `last_synced_output` handling.
- A new gate, an added `after` and an added `requires_record` on a pending gate are applied.
- A gate missing from the plan stays.

**Conflicts:** each case in Design 2 gives exit 6, and `status.yaml` and `meta.yaml` stay byte-identical.

**Writer unchanged:** the 2A section W golden and the 2B/2C suites pass.

**`run-agent.sh`:**
- sync exit 6 routes to `validation_failed` with the reason;
- a task with gates gets the `--- COMPLETION GATES ---` block;
- a task without gates gets a byte-identical prompt.

The prompt is captured through the run record or a dry dispatch.

**Role contracts:** each of the five contains the "Completion gates" rule naming `update-completion-gate.rb`.

**Renderer move:** `gate-status.sh` (2D) passes unchanged.

**Regression:** every suite from 1A–1D and 2A–2D passes.

## Rollout, evidence and rollback

- **Additive and opt-in.** A PM output without `completion_gates` syncs as before. The role-contract changes are instructions. The prompt block appears only for tasks with gates or revisions.
- **Evidence that it earns its place:** after use, count new tasks whose gates were declared by PM through sync (actor `pm`, history `absent -> pending`), and how often `after`, `requires_record` and `--ran-*` appear. Before 2E, all of these were zero.
- **Rollback is a revert.**
  - The pre-2E validator accepts a PM output carrying `completion_gates` (checked on main e5966448).
  - The pre-2E sync ignores the field.
  - Gates already declared by sync are ordinary governed records and keep working.

## Documented limits

- Roles may still not follow the instructions. 2E guarantees that gates PM declares land in `status.yaml` correctly; passing them is left to the roles, with the existing writer and guards enforcing the rules.
- PM must decide which gates a task needs; nothing infers them.
- Gates added after work began do not require a 2A revision.
- The dashboard is unchanged.

## Deferred

- A reviewer gate checklist in its output.
- Inferring gates from task type.
- Requiring revisions for gates added mid-task.
- Dashboard UI.
- Governed intake for operators (outside PM).
- Merge/push authorization actions.
- Branch ordering.
- The Execution Blueprint.

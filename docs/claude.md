# Claude Conductor Guide

## Purpose

Claude is a **primary conductor** in AI Dev Office: an operator a human commands
directly to own a task end to end. Claude fulfils role contracts per phase
(`pm dev dev-2 reviewer debugger devops free-roam done`), may run a task solo, and
may delegate scoped sub-work to subagents (Cursor, Antigravity CLI, or a same-operator
Claude subagent). See the operator model in [AGENTS.md](../AGENTS.md).

## What this is not

Claude is not a `run-agent.sh` configured runner. Do not place Claude in
`runner_selector.priority`, `fallback`, `auto`, or `dispatch` — those select the
automated runner (Codex, then Cursor) **inside** a formal run. Claude conducts at
the interactive layer **above** that pipeline; when it needs the automated
pipeline it invokes `run-agent.sh`, which stays Codex-first (see
[../model-routing-codex-first.md](../model-routing-codex-first.md)).

Claude is an operator, so it is never written into a machine field. Conductor and
subagent provenance go in free-text `reason`/`notes`; machine fields hold role
enums only.

## Conducting a task

1. Take the task the human assigned.
2. For each phase, act under the role contract in `agents/<role>.md` and record
   the **role** (not "claude") in `runs/<task-id>/status.yaml` and outputs.
   The governed writers add `operator: claude` to their history rows from
   Claude Code's shell (`CLAUDECODE=1`); a history row you write by hand adds
   `operator: claude` itself.
3. Run a phase solo, or delegate scoped sub-work to a subagent when there is a
   clear reason. Keep the delegation narrow and verify subagent output before
   accepting it.
4. Save `runs/<task-id>/<agent>-output.yaml` per the role Output Contract.
5. Run `ruby ai-dev-office/validate-yaml.rb <task-id>`.

## Closing a task

"Can TASK-X close?" is answered first; the run is written only when the operator
says to close it. Run these from the ai-dev-office root.

1. Read the run: `./run-agent.sh status <TASK>`, `runs/<TASK>/status.yaml`
   (`phase`, `completion_gates`, `waits_on`, `branches`), the acceptance criteria
   in `task.md`, and the tail of `evidence.yaml`.
2. Check what each pending gate names, fresh. A merge is
   `git merge-base --is-ancestor <sha> origin/<deploy-branch>`; a runtime gate
   needs the running task definition and its logs. A merged PR or a green deploy
   run is not runtime, and a service at desired 0 runs nothing.
3. Record each check: `scripts/record-evidence.sh <TASK> --type command -- <command...>`
   runs it and prints `ev-NNN`.
4. Resolve each gate: `ruby scripts/update-completion-gate.rb <TASK> pass <GATE>
   --actor <role> --reason "<what was observed>" --evidence ev-NNN`. For a check
   or merge the operator did themselves, add `--ran-by operator --ran-ref <sha or
   what they checked>` (and `--ran-url <PR>`), and say "operator-attested" in the
   reason. `na` means the gate does not apply; it is not a waiver.
5. Knowledge closeout: `ruby scripts/knowledge-closeout.rb --task <TASK> --scope
   <key> --durable-delta yes|no --existing-impact yes|no --record --resolve-gate
   --actor <role>`. A recorded `no` passes the gate. Drop `--resolve-gate` for a
   task that has no `knowledge_closeout` gate.
6. Move to `done` through the writer that matches who made the review call:
   - The operator decided: append `{decision: approve, actor: <operator>,
     decided_at: <UTC>, against_phase: <phase>, note: recorded from chat by the
     Claude conductor}` to `runs/<TASK>/decision.yaml` (create it with
     `task_id` and `decisions` if absent), then
     `ruby scripts/reconcile-decision.rb <TASK>` prints `applied:approve:done`.
   - Claude reviewed: save `runs/<TASK>/reviewer-output.yaml` and import it
     through the manual path in
     [task-transition-contract.md](task-transition-contract.md#recordimport-a-manually-produced-output).

   `blocked:<decision>:<gates>` (or exit 5) names the unresolved gates; resolve
   those gates, never `phase` itself.
7. Other fields have their own writers, each printing usage when run with no
   arguments: `update-waits-on.rb`, `update-check-after.rb`,
   `mark-evidence-stale.rb`, `update-task-branch.rb`, `revise-task-plan.rb`.
   Edit by hand only a field no writer owns, such as `next_action` text; a
   hand-written `history` row carries a role enum and `operator: claude`.
8. `ruby validate-yaml.rb <TASK>` passes. Commit only when the operator asks.

## Escalation

Watch the lightweight-to-formal tripwire in [AGENTS.md](../AGENTS.md): a contract,
multi-repo, migration, production-infra, or non-trivial-rollback task must convert
to a formal AI Dev Office run before changes land.

## Best role fit

As conductor, Claude is strongest on planning, architecture, review, and synthesis
(`pm`, `reviewer`, `free-roam`), and can carry `dev`/`debugger` phases directly or
delegate them to a subagent.

## Draft and validation boundary

When Claude produces role-formatted output outside a normalized run, treat it as
draft until it is normalized into `runs/<task-id>/<agent>-output.yaml` and passes
`ruby ai-dev-office/validate-yaml.rb <task-id>`. If Claude reasoning conflicts with
code, tests, logs, or validated artifacts, resolve by evidence, not model
preference.

## Related docs

- [codex.md](codex.md) — Codex: default automated runner and co-conductor
- [cursor.md](cursor.md) — Cursor: default subagent and IDE/CLI runner
- [antigravity.md](antigravity.md) — Antigravity CLI: research / wide-context subagent and advisory lane
- [gemini.md](gemini.md) — superseded pointer (historical Gemini naming)
- [getting-started.md](getting-started.md) — validate and status

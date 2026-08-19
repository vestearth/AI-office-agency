# Orchestration Boundary

Status: **Phase 1 of [#23](https://github.com/vestearth/AI-office-agency/issues/23)
— documentation only.** No script, schema, or config file changed. This
document describes the boundary as it exists in the code today and proposes
where a later phase would cut; it does not implement any cut.

Non-goals (repeated from the issue, because it is easy to over-read a
boundary document as an announcement of removal): `run-agent.sh auto` is not
being removed, deprecated, or made harder to use. No runtime is being made
mandatory. Nothing here changes what a currently-running task does next.

## 1. `run-agent.sh auto` is documented as optional, not primary

`./run-agent.sh <TASK_ID> auto` is one local, standalone execution path among
several. It is a convenience loop (see [`§4`](#4-the-auto-loop-is-the-clearest-boundaryglue-example))
that repeatedly shells into the same script's single-role dispatch
(`./run-agent.sh <TASK_ID> <ROLE> [RUNNER]`) and stops when a role produces no
`next_action`, hits `done`, or the task becomes `blocked`. Every step `auto`
performs is also available one at a time, manually, and the workflow state
(`status.yaml`, `<role>-output.yaml`) that results is identical either way —
see [§3](#3-the-resilience-requirement-mapped-to-what-already-works-manually).

Today several docs describe `auto` in a way that reads as "the" pipeline
rather than "a" pipeline, because historically it was the only pipeline this
framework shipped. This is a documentation gap, not a behavior change, and
Phase 1 closes it with cross-references rather than rewrites (rewriting the
existing wording is a Phase 2/3-shaped edit — restructuring prose that
describes current, unchanged behavior is out of scope here). The following
places now point at this document; their own wording is untouched:

| File | What it said before (unchanged) | Cross-reference added |
|---|---|---|
| `README.md` | `./ai-dev-office/run-agent.sh TASK-011 auto` listed as one of four "Quick commands", no framing as primary vs. optional | Doc table row → this file |
| `AGENTS.md` | "Framework boundaries" lists `runners/`, `agents/`, `schemas/`, `scripts/`, `workflows/` as "the framework runtime" without separating workflow state from execution | New paragraph after "Framework boundaries" → this file |
| `QUICKSTART.md` | "## Auto Pipeline" section presents `auto` right after the manual `pm`/`dev`/`reviewer` flow, with no optional/standalone framing | Note added under the section heading → this file |
| `docs/getting-started.md` | "## Auto pipeline" section, same pattern as QUICKSTART | Note added under the section heading → this file |

None of the four files had their existing commands, examples, or claims about
`auto`'s behavior altered — only a pointer to this document was added, per
Phase 1's "document" scope (see `git diff --stat` in the PR/branch for the
exact, minimal diff).

## 2. The four boxes, grounded in this repo today

The issue's target architecture is four boxes. This repo does **not**
currently implement that separation — `ai-dev-office` (the workflow kernel)
and the runtime/control-plane concern are both inside the same repo, mostly
inside the same file (`run-agent.sh`). What follows is not aspirational: it
names the actual files that already act as each box's contents, and the
actual files/functions that belong in a box this repo doesn't yet have
carved out.

### WHAT NEXT (workflow kernel — ai-dev-office's real job)

Already exists as concrete, addressable artifacts, independent of any
runtime:

- **State**: `runs/<task-id>/status.yaml` — `task_id`, `phase`, `state`,
  `iteration`, `current_agent`, `blocked_on`, `waiting_for`, `history`,
  `handoff`, `assignment`. Schema: `schemas/status.schema.yaml`. Runtime
  validator (the actual enforced rules): `validate-yaml.rb`'s `PHASES`
  constant (line 12) and `STATUS_ACTORS`/`AGENTS` (lines 9-10).
- **Role contracts / handoffs**: `runs/<task-id>/<role>-output.yaml`.
  Schema: `schemas/agent-output.schema.yaml` (base contract: `summary`,
  `artifacts`, `next_action.agent`/`next_action.reason`, `blockers`),
  extended per-role by `schemas/reviewer-output.schema.yaml` (adds
  `review_verdict`, `build_check`), `schemas/dev-output.schema.yaml`,
  `schemas/dev-2-output.schema.yaml`, `schemas/debugger-output.schema.yaml`,
  `schemas/devops-output.schema.yaml`, `schemas/free-roam-output.schema.yaml`,
  `schemas/pm-output.schema.yaml`.
- **Transition logic**: the Ruby routines embedded in `run-agent.sh` that
  read a role's output and compute the next `phase`/`current_agent` —
  `sync_status_from_output` (~line 1857), `force_status_route` (~line 2263),
  `reconcile_blocked_status` (~line 1714), `next_agent_from_output` (~line
  2075). These are workflow logic today; see
  [`docs/run-agent-classification.md`](run-agent-classification.md) for why
  they are workflow and not runtime, and for the fact that they are
  currently *only* reachable by shelling into `run-agent.sh` rather than as
  standalone scripts.
- **Escalation / loop protection policy**: the loop-guard and
  execution-budget checkpoints in `run-agent.sh`'s main dispatch body
  (~lines 2485-2617), backed by `scripts/execution-budget.rb` (`docs/execution-budget.md`)
  and `office.config.yaml`'s `loop_guard.*` keys.
- **Validation**: `validate-yaml.rb` (schema + cross-field rules,
  runtime-independent — it is a plain Ruby CLI with no runner dependency) and
  `scripts/enforce-output-contract.rb` (gates a single role's output against
  its schema and routes to `validation_failed` on failure; also runtime-independent).
- **Review/reject/retry**: `scripts/reconcile-decision.rb` (applies
  `runs/<task-id>/decision.yaml`, written by a human or the dashboard, into
  `status.yaml`) and the reviewer's `review_verdict` enum
  (`approved`/`changes_requested`/`escalate`/`infra_failure` — see
  `schemas/reviewer-output.schema.yaml`).

### HOW (ai-skills — not this repo, referenced only)

`ai-skills/` (a sibling repo) supplies reasoning/review guidance consumed by
whichever runtime executes a role. `ai-dev-office` references it (e.g.
`docs/socraticode.md`, role prompts under `agents/*.md`) but does not own it.
Out of scope for this document beyond noting the boundary is already
respected — no ai-skills content lives inside `ai-dev-office`.

### WHAT WE KNOW (knowledge-base — not this repo, referenced only)

Same shape as ai-skills: `workflows/knowledge-capture.md` and
`workflows/knowledge-librarian.md` describe how ai-dev-office *proposes*
writes into the separate `knowledge-base/` repo; ai-dev-office itself stores
no durable knowledge. Already a clean boundary.

### WHO EXECUTES (runtime/control-plane — currently fused into `run-agent.sh`)

This is the box that does **not** exist as a separate artifact today. Its
logic lives inside `run-agent.sh`, interleaved with the workflow logic above:

- **Runner selection**: `runner_priority_values`, `runner_trigger_patterns`,
  `runner_retry_before_switch`, `next_runner_after` (~lines 1210-1247),
  driven by `office.config.yaml`'s `runner_selector.*` keys.
- **Process invocation**: `run_runner_once` (~line 1281) — the only place
  that actually execs `codex`, shells out to `cursor agent`, or writes a
  `.cursor-prompt.md` for the IDE lane.
- **Retry/fallback between runner binaries**: `run_runner_with_fallback`
  (~line 1320).
- **The `auto` pipeline's per-step subprocess invocation**: the `while`
  loop at ~line 2619, which repeatedly calls `run_agent_invocation` (itself
  just `"$0" "$@"` — re-execing this same script).
- **Prompt assembly for a specific runner**: the block from ~line 2683
  through the `PROMPT="..."` construction at ~line 2779 — pulling in task
  file, status, PM output, previous-role output, review-depth section, and
  the SocratiCode context-index section, then formatting it as the text a
  runner subprocess receives on stdin/argv.

`runners/codex.yaml` and `runners/cursor.yaml` (if present — see `runners/`
directory) are the declarative, runtime-specific counterpart: they describe
how to invoke a given binary, not what the task should do next.

This box is not purely hypothetical scaffolding — a concrete example of a
third-party runtime/control-plane already exists on this machine, outside
this repo: [Multica](https://github.com/multica-ai/multica), a desktop
daemon that is currently installed and running here. It is unrelated to
`ai-dev-office` today (no adapter or integration exists, and building one is
explicitly out of scope for this issue's Phase 1-2), but it is worth naming
because its own workspace layout independently arrived at a structure that
rhymes with this repo's: each Multica workspace carries a
`.multica/daemon_task_context.json` and an `.agent_context/` directory (with
`issue_context.md` and its own `skills/` subdirectory) that a dispatched
agent reads from — a per-task "context + skills" sidecar, conceptually
parallel to this repo's `runs/<task>/status.yaml` + the sibling `ai-skills/`
repo. That parallel is offered only as grounding for what a real
runtime/control-plane box looks like; no adoption, comparison-as-roadmap, or
integration decision is implied or being made here. (The issue text also
names "Munder" as a possible source of mailbox/blackboard/loop/escalation
patterns for this box — that effort is on hold and not being pursued right
now, so it isn't discussed further in this document.)

Full function-by-function classification, with the honest "this one is
actually mixed" calls, is in
[`docs/run-agent-classification.md`](run-agent-classification.md).

## 3. The resilience requirement mapped to what already works manually

The issue's resilience requirement: if no external orchestrator is ever
installed, an operator must still be able to (1) inspect current task state,
(2) determine the next role/action, (3) run that action manually, (4)
record/import the resulting output, (5) validate and transition the task,
(6) optionally run the whole thing via the existing local `auto` runner.
Walking through each point against what is actually in this repo today:

**(1) Inspect current task state — already works, no runtime involved.**
`cat runs/<task-id>/status.yaml`, or the read-only summary:
`./run-agent.sh status <TASK_ID>` (the `show_office_status` Ruby heredoc,
~line 98) reads `status.yaml` and `history` directly off disk. Neither path
invokes a runner.

**(2) Determine the next role/action — already works.** `current_agent` in
`status.yaml` *is* the answer, maintained by the transition logic in §2. The
`status` command also prints a computed `Next: ./run-agent.sh <TASK_ID>
<current_agent>` line (`next_command`, ~line 126) purely from `status.yaml`
fields — no runner call.

**(3) Run that action manually — already works, and is distinct from
`auto`.** `./run-agent.sh <TASK_ID> <ROLE> [RUNNER]` dispatches exactly one
role and stops; it does not loop. `auto` is implemented as this same
single-role command called repeatedly (§2, "process invocation"). Confirmed
by reading the code, not assumed from naming: the `AGENT == "auto"` branch
(~line 2619) is the *only* place the `while` loop lives; every other branch
in the script (scaffold, single-role dispatch, `status`, `intake`, `verify`,
`cleanup`) runs once and exits. A human can pick any `RUNNER` (`codex`,
`cursor-agent`, `cursor`) per call, including the `cursor` runner, which
performs no AI invocation at all — it only writes
`runs/<task-id>/.cursor-prompt.md` and lets the operator do the work by hand
in any tool.

**(4) Record/import the resulting output — already works, and is the
`cursor` runner's actual design purpose, not a workaround.** See
[`docs/task-transition-contract.md`](task-transition-contract.md#recordimport-a-manually-produced-output)
for the exact mechanics (output-file mtime check, idempotency digest). In
short: dispatch with the `cursor` runner, do the work anywhere, save
`<role>-output.yaml` by hand, re-run the identical command — the driver
detects the file was updated after the run started and proceeds through the
normal contract-enforcement and sync path, identical to what a fully
automated runner would trigger.

**(5) Validate and transition the task — already works as standalone
commands.** `ruby validate-yaml.rb <TASK_ID>` runs standalone with no runner
dependency (it is a plain Ruby script; its only repo-internal requires are
`scripts/review-gate.rb` and `scripts/resolve-office-config.rb`, neither of
which touches a runner). `scripts/enforce-output-contract.rb <TASK_ID>
<AGENT>` likewise takes only a task id and role name and needs no runner or
run-identity context — see its usage banner ("Usage: ruby
scripts/enforce-output-contract.rb <TASK_ID> <AGENT>"). The one piece that
is **not** a standalone script is `sync_status_from_output` itself — it is a
Ruby heredoc defined inside `run-agent.sh`, invocable only by going through
that script's main dispatch body. This is the concrete coupling point noted
in [`docs/task-transition-contract.md`](task-transition-contract.md#coupling-points-not-yet-runtime-independent)
and in [`docs/run-agent-classification.md`](run-agent-classification.md).

**(6) Optionally run the whole thing via `auto` — already the actual
behavior; nothing to change.** `auto` remains available and default-Codex,
exactly as documented in `README.md`/`QUICKSTART.md`/`docs/getting-started.md`
today.

**Honest summary**: five of six resilience points already work today with
zero code changes, using only artifacts that were built for other reasons
(the `cursor` runner's file-based hand-off, `validate-yaml.rb`'s standalone
CLI, `status.yaml` being a plain file). The one real gap is that the
transition logic itself (`sync_status_from_output`, `force_status_route`,
`reconcile_blocked_status`) is not independently invocable — it is private
to `run-agent.sh`. That is the concrete, scoped finding this Phase 1 pass
produces for Phase 2, not a design flaw to fix here.

## 4. The `auto` loop is the clearest boundary/glue example

Worth calling out on its own: the `auto` pipeline's `while` loop (~line
2619) is simultaneously the single clearest example of workflow logic
("what's the next step, is the plan valid, should this go parallel") and
runtime logic ("re-exec this script as a subprocess, wait for it, read its
exit code") sharing one loop body. Anyone attempting Phase 2's extraction
should expect to split this loop into: a workflow-kernel function that
decides `next_agent_from_output` + validity, and a runtime adapter that is
told "run role X" and reports back "role X produced this output file" — with
`run-agent.sh`'s own re-exec becoming just one implementation of that
adapter (others being a human retyping a `run-agent.sh` command, or, in
principle, a separately-running local control plane like Multica — see §2's
"WHO EXECUTES" box above for what that grounds; no such adapter is being
designed here). See
[`docs/run-agent-classification.md`](run-agent-classification.md#boundaryglue-the-auto-loop)
for the line-level detail.

## 5. Documents produced by this pass

- [`docs/run-agent-classification.md`](run-agent-classification.md) — every
  major function/region in `run-agent.sh`, classified workflow / runtime /
  boundary-glue, with line ranges.
- [`docs/task-transition-contract.md`](task-transition-contract.md) — the
  minimum stable task/transition contract: what `status.yaml` and
  `<role>-output.yaml` must contain, what "record/import manually" concretely
  means today, and the specific coupling points that are not yet
  runtime-independent.

## 6. Recommendations for Phase 2 (not implemented here)

Recorded as recommendations only — no code in this branch acts on them:

1. Extract `sync_status_from_output`, `force_status_route`, and
   `reconcile_blocked_status` out of `run-agent.sh`'s Ruby heredocs into
   standalone scripts under `scripts/` (mirroring `reconcile-decision.rb`,
   `execution-budget.rb`), so the transition logic is callable by any driver,
   not only by shelling into `run-agent.sh`.
2. Give the `auto` loop's decision half ("what role runs next, is the PM's
   parallel plan valid") a narrow, testable interface separate from its
   execution half ("exec this script again and wait"), so a different
   runtime adapter can supply the execution half without reimplementing the
   decision half.
3. Decide, deliberately, whether `AI_DEV_OFFICE_RUN_ID`-keyed ownership
   leases should remain `run-agent.sh`-only (documented limitation) or be
   generalized so an external orchestrator can participate in the same fence
   — see the coupling points list in `docs/task-transition-contract.md`.

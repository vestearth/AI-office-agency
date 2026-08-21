# Runtime adapter contract

Status: **Phase 3 of [#23](https://github.com/vestearth/AI-office-agency/issues/23)
— documentation plus one reference script
(`scripts/adapter-status.rb`).** This does not introduce a new abstraction.
It names, as a stable interface, the operations Phase 2 already built as
standalone scripts (`docs/orchestration-boundary.md` §7,
`docs/task-transition-contract.md`) and describes how an external
runtime/control-plane — Multica, a future dispatcher, or a human with a
shell — can drive `ai-dev-office` tasks through them without becoming part
of the workflow kernel and without `ai-dev-office` needing to know the
adapter exists.

Non-goal, repeated because it is easy to misread a contract doc as an
announcement of a new integration: **no adapter that talks to a specific
external runtime is built here.** `run-agent.sh auto` remains the only
first-class local execution path this repo ships; everything below is
either already-shipped Phase 2 machinery being pointed at from a new angle,
or a new read-only script that the workflow kernel does not call and does
not depend on.

## 1. Multica re-checked (corrects the Phase 1/2 record)

`docs/orchestration-boundary.md` §2 said, as of Phase 1/2: "no adapter or
integration exists, and building one is explicitly out of scope." That
remains true. But the same section, and a similar note the orchestrating
session made when scoping this phase, understated what is actually present
on this machine — worth correcting on the record before anyone reads
"no Multica CLI" as settled fact:

- `which multica` finds nothing, because the CLI is not on `PATH` — **not**
  because no CLI exists. It ships bundled inside the desktop app:
  `/Applications/Multica.app/Contents/Resources/app.asar.unpacked/resources/bin/multica`,
  a 23MB arm64 Mach-O binary, confirmed present and runnable (`multica
  --help` succeeds) during this phase's investigation.
- That binary is a real, documented, substantial CLI, not a stub. `multica
  --help` lists `agent`, `issue`, `runtime`, `autopilot`, `chat`, `project`,
  `repo`, `squad`, `skill`, `workspace`, `daemon` as top-level command
  groups. `multica issue --help` in particular exposes `assign`,
  `cancel-task`, `status`, `rerun`, `runs`, `run-messages`, `timeline` —
  vocabulary that maps recognizably onto "dispatch this to an agent,"
  "what's the execution history," "what changed and when," i.e. the same
  shape of questions this repo's own `status`/`history`/`run-records`
  answer for a `runs/<task-id>/`.
- A sibling repo already documents part of this CLI for a *different*
  purpose: `ai-skills/adapters/multica/README.md` describes importing
  `ai-skills` content into a Multica workspace via `multica skill import` /
  `skill refresh` / `agent skills add`. That adapter is about skill
  *distribution*, not task *orchestration* — it does not touch
  `ai-dev-office` task state, `runs/`, or `status.yaml` in any way, and nothing
  in this phase changes or depends on it. It is cited here only as evidence
  that a documented `multica` CLI surface is a known quantity elsewhere in
  this workspace, not a discovery unique to this investigation.
- What was **not** found, and what the mandate for this phase turns on: no
  documented, stable way for an *external* process to tell Multica "here is
  an `ai-dev-office` task id, here is its `next_action`, please dispatch an
  agent against it and hand the result back in a format `ai-dev-office`
  understands." `multica issue`/`agent` operate on Multica's own issue and
  agent objects inside a Multica workspace, not on this repo's
  `runs/<task-id>/status.yaml`. Building that bridge would mean either (a)
  teaching `ai-dev-office` to create/track Multica issues as a
  representation of its own tasks — which the issue's non-goals explicitly
  forbid ("do not migrate task semantics into an external control plane"),
  or (b) writing a genuinely new translation layer with no existing
  workspace, authentication, or issue mapping to build it against safely
  inside this session's read-only mandate.

**Net correction:** the earlier framing ("no CLI, no documented API,
nothing to build against") was too strong — a real CLI exists and is
richer than assumed. The scoping conclusion is unchanged for a narrower,
correct reason: a documented *skill-distribution* integration exists
(unrelated to task orchestration, already merged, untouched here), and a
documented *task-orchestration* bridge does not exist and is not safe to
invent inside this phase's constraints (no daemon interaction, no
speculative cross-system id mapping, no assumption that this machine's
single-user Multica workspace generalizes). §5 below sketches, without
implementing, how such a bridge *would* map onto the contract if someone
builds it later.

## 2. The contract: five operations, already implemented

Any adapter author — human, script, or a future Multica-side automation —
needs exactly these five capabilities. Every one of them already exists as
a standalone command with a stable ARGV/exit-code contract; nothing here is
new.

| # | Operation | Command | Contract |
|---|---|---|---|
| 1 | Read current task state | `cat runs/<task-id>/status.yaml`, or `./run-agent.sh status <task-id>` for the human-readable form, or `ruby scripts/adapter-status.rb <task-id>` for machine-readable JSON (§3) | `docs/task-transition-contract.md` §1 — `task_id`, `phase`, `iteration`, `current_agent` are schema-required; `current_agent` is the practical answer to "what's next." |
| 2 | Determine next role/action | `current_agent` field from operation 1; or, once a role's output file already exists, `ruby scripts/next-agent-from-output.rb <AGENT> <OUTPUT_FILE>` to preview `next_action.agent` before it is synced | `docs/task-transition-contract.md` §2 — reads `next_action.agent`, with the reviewer `review_verdict` fallback. Pure reader, no write. |
| 3 | Execute a role | However the adapter wants: `./run-agent.sh <task-id> <role> [codex\|cursor-agent\|cursor]`, a direct API/CLI call to any AI runtime, or a human doing the work by hand | Not standardized by this repo, deliberately — this is the "WHO EXECUTES" box (`docs/orchestration-boundary.md` §2) and staying execution-agnostic here is the entire point of the issue. The only requirement downstream is operation 4. |
| 4 | Report a role's output back | Write `runs/<task-id>/<role>-output.yaml` conforming to `schemas/agent-output.schema.yaml` (base) or its per-role extension | `docs/task-transition-contract.md` §2 — `summary`, `artifacts`, `next_action.agent`/`next_action.reason`, `blockers` required. No run identity, no runner name, no `AI_DEV_OFFICE_RUN_ID` is read when this file is later validated or synced — a hand-written file that satisfies the schema is indistinguishable from a machine-produced one. |
| 5 | Validate and transition | `ruby validate-yaml.rb <task-id>` (schema + cross-field validation), then `ruby scripts/enforce-output-contract.rb <task-id> <agent>` (contract gate → `validation_failed` on failure), then `ruby scripts/sync-status-from-output.rb <task-id> <agent> <status-file> <output-file> <today> <reviewer-queue-phase>` (applies the transition) | `docs/task-transition-contract.md` §§ "record/import" and "coupling points." All three are standalone Ruby scripts, callable with no runner and no `run-agent.sh` dispatch. This is the concrete, tested answer to the issue's `office validate` / `office transition` proposed commands — the operations already exist under these names; nothing new needed to be built to expose them. |

Two supporting operations an adapter should know about but does not have to
use:

- **Escalation / loop protection reconciliation** —
  `ruby scripts/reconcile-blocked-status.rb <task-id> <status-file>
  <runs-dir> <today> <unblock-phase> <reviewer-queue-phase>
  <clear-waiting-for> <set-ready> <route-from-assignment>` — re-evaluates a
  `blocked` task's dependencies. An adapter that dispatches work across
  multiple tasks with `blocked_on` relationships should call this after any
  transition that might unblock a dependent task, the same way
  `run-agent.sh`'s own dispatch body does.
- **Mutual exclusion** — `ruby scripts/task-ownership.rb acquire
  <task-dir> <task-id> run_id=<id> agent=<role>` before dispatching, and
  `release` after. Optional and advisory (`docs/task-ownership.md`'s Phase 2
  decision: the fence fails open for any writer that never calls it — it is
  not an access-control boundary), but an adapter that wants to avoid
  racing a concurrently-running `run-agent.sh auto` on the same task should
  mint its own `run_id` and participate in the same fence. No code changed
  here; this capability was already complete as of Phase 2.

**What decides the interface's stability**: every command in the table
above is named explicitly, with its exact ARGV and exit codes, in
`docs/task-transition-contract.md` (written in Phase 1, extracted to
standalone scripts in Phase 2) and pinned by
`tests/integration/schema-validator-parity.sh` and the driver/decision e2e
tests. An adapter author should treat that document, not this one, as the
byte-level reference; this document only names *which* of those pieces to
call, in what order, and why.

## 3. Reference adapter A: `scripts/adapter-status.rb` (new, this phase)

A small, real, testable script an external tool can poll to answer "what
should happen next for TASK-X" as JSON, built directly on operation 1/2
above (`docs/task-transition-contract.md`'s `status.yaml` fields plus
`NextAgentFromOutput.compute`, the same library function
`scripts/next-agent-from-output.rb` and `scripts/decide-next-step.rb`
already use — not re-implemented, required in-process).

```
ruby scripts/adapter-status.rb <TASK_ID> [--pretty]
```

Output shape (all fields always present; absent values are `null`/empty,
never a missing key):

```json
{
  "task_id": "TASK-EXAMPLE-1",
  "phase": "assigned",
  "state": "assigned",
  "current_agent": "dev",
  "iteration": 0,
  "blocked_on": [],
  "waiting_for": [],
  "terminal": false,
  "blocked": false,
  "next_command": "./run-agent.sh TASK-EXAMPLE-1 dev",
  "pending_manual_output": null,
  "last_synced_output": null,
  "validation": "pass",
  "recent_history": []
}
```

When a role's output file already exists on disk but has not yet been
synced into `status.yaml` — the exact "did the work by hand, saved the
file, about to re-run to record it" state
`docs/task-transition-contract.md`'s record/import section describes —
`pending_manual_output` is populated:

```json
"pending_manual_output": {
  "path": "runs/TASK-EXAMPLE-1/dev-output.yaml",
  "exists": true,
  "already_synced": false,
  "next_agent_preview": "reviewer"
}
```

This lets an adapter distinguish "nothing has happened yet, dispatch role
X" from "role X already finished by hand, just needs recording" without
re-implementing the digest/idempotency check `sync-status-from-output.rb`
already owns — the script only *reads* `last_synced_output` and compares a
freshly computed digest against it; it never writes.

**Guarantees**: read-only (no `status.yaml` write, no runner invocation, no
ownership acquisition — proven by the integration test below, which
asserts `status.yaml` is byte-identical before and after a query against a
task with a pending unsynced output). Exit 0 on any valid task regardless
of its state (pending, unsynced, terminal, blocked); exit 1 for an unknown
task id; exit 2 on a usage error. Nothing in the workflow kernel calls this
script — it is purely an optional, additive read surface.

**How it was tested end-to-end**:
`tests/integration/adapter-status.sh` (discovered by the same
`tests/integration/*.sh` glob every full-regression run already uses) sets
up four real `runs/<task-id>/status.yaml` fixtures — an assigned task with
no output yet, an assigned task with a hand-written unsynced
`dev-output.yaml`, a terminal (`done`) task, and a `blocked` task — plus an
unknown-task-id case, and asserts the exact JSON fields against each,
including the read-only guarantee. All five scenarios pass (see the
Verification section of the PR/report for the run).

## 4. Reference adapter B: the `cursor` runner, reframed

`run-agent.sh`'s existing `cursor` runner (`run_runner_once`'s `cursor`
case) already **is** a generic, working, runtime-agnostic adapter — it was
built for Cursor specifically, but nothing about its mechanism is
Cursor-specific. Restating it explicitly as the reference implementation of
operations 3+4 above, since Phase 3's job includes generalizing this
pattern rather than inventing a new one:

1. Dispatch with the `cursor` runner: `./run-agent.sh <task-id> <role>
   cursor`. This performs **zero** AI invocation — it assembles the same
   prompt any other runner would receive (task file, status, prior role
   outputs, review-depth section, SocratiCode context) and writes it to
   `runs/<task-id>/.cursor-prompt.md`.
2. The actual execution (operation 3) happens entirely outside this repo's
   knowledge: paste the prompt into Cursor, or Multica, or a different AI
   product, or do the work by hand. `ai-dev-office` has no visibility into
   this step and does not need any.
3. Whatever executed the work saves `runs/<task-id>/<role>-output.yaml`
   (operation 4) conforming to the schema — again, by any means: the tool
   itself, a copy-paste, a script.
4. Re-run the identical command: `./run-agent.sh <task-id> <role> cursor`.
   The driver compares the output file's mtime against when this second
   run started; if it is fresher, it proceeds through
   `enforce-output-contract.rb` → `sync-status-from-output.rb` →
   `validate-yaml.rb` (operation 5) exactly as a fully automated runner
   would.

The only thing "Cursor" contributes to this pattern is the name of the
runner flag and the wording of the two `echo` lines in
`run_runner_once`'s `cursor` case (`run-agent.sh`, ~lines 1289-1298) — an
operator prompted to open Multica instead of Cursor loses nothing by
substituting tools, because steps 2-3 are already outside this repo's
knowledge by design. No code change was needed or made to generalize this;
it was already general. A future Multica-side automation, if one is ever
built, could use exactly this mechanism today: run step 1, hand the saved
`.cursor-prompt.md` to a Multica agent via `multica issue assign` /
whatever dispatch mechanism it exposes, wait for the agent to run, take
its result, write it to `<role>-output.yaml`, and re-run step 4. That is a
complete, safe integration path that requires zero new code in this repo —
named here as a worked example of what §1's "no orchestration bridge
exists yet" leaves fully open to build later, without this phase building
it.

## 5. If a real Multica task-orchestration bridge is built later (not now)

Sketched only so a future implementer does not have to re-derive the shape
from scratch — nothing below is implemented, tested, or assumed stable:

- **Reading state into Multica**: a Multica-side automation could poll
  `ruby scripts/adapter-status.rb <task-id> --pretty` (or, for a whole
  workspace, iterate `runs/*/`) and surface `next_command`/`current_agent`
  as a Multica issue's description or a custom property
  (`multica issue property` / `multica property` per `multica issue
  --help`/`multica property --help`).
- **Dispatch**: `multica issue assign` (per `multica issue --help`) to hand
  a task to a Multica agent, using reference adapter B's prompt (§4) as the
  issue body/instructions — not a new prompt format.
- **Reporting back**: whatever the Multica agent produces would need
  translating into `runs/<task-id>/<role>-output.yaml` satisfying the
  schema (operation 4) — this translation step is the actual unbuilt
  bridge; everything before and after it already exists.
- **Explicitly not** in this sketch: minting `AI_DEV_OFFICE_RUN_ID` values
  from Multica-side run/task ids, mapping Multica's own issue lifecycle
  onto `phase`/`state`, or writing into any of the private
  `~/.multica`/`~/multica_workspaces_*` files this phase's investigation
  found — none of that is a documented, stable surface, and the issue's own
  non-goals ("do not migrate task semantics into an external control
  plane") argue against building it even if it became documented later
  without a concrete need driving it.

## 6. What this phase deliberately did not build

- No Multica-specific script, config key, or schema field. `git grep -il
  multica -- . ':!docs/*'` returns only a pre-existing, unrelated
  false-positive match on the word "multicast" in a task's status.yaml —
  confirmed by inspection, not new from this phase.
- No change to `schemas/*.yaml` — every field this contract cites already
  existed before this phase.
- No change to `run-agent.sh`, `scripts/decide-next-step.rb`,
  `scripts/next-agent-from-output.rb`, `scripts/sync-status-from-output.rb`,
  `scripts/force-status-route.rb`, or `scripts/reconcile-blocked-status.rb`
  — `scripts/adapter-status.rb` requires `next-agent-from-output.rb` as a
  library and calls the others by name in this document's prose only.
- No decision about `run-agent.sh auto`'s future — that remains Phase 4,
  untouched here.
- Munder: not researched, not referenced beyond this sentence. The
  operator has explicitly put Munder work on hold; the issue's own Phase 3
  text treats it as optional ("unless a stronger use case emerges"), and
  none emerged during this phase.

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
3. Run a phase solo, or delegate scoped sub-work to a subagent when there is a
   clear reason. Keep the delegation narrow and verify subagent output before
   accepting it.
4. Save `runs/<task-id>/<agent>-output.yaml` per the role Output Contract.
5. Run `ruby ai-dev-office/validate-yaml.rb <task-id>`.

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

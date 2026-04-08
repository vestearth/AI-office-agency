---
name: ai-dev-office
description: >-
  Multi-agent dev office framework for orchestrating AI agents as a dev team.
  Use when the user wants to create tasks, assign work to agents, run the dev
  pipeline, check task status, or manage the AI Dev Office workflow. Triggers:
  "create task", "assign to dev", "run agent", "check status", "office",
  "pipeline", "PM", "reviewer", "debugger", "devops", "free roam".
---

# AI Dev Office

Multi-agent framework with 7 agents: PM, Dev, Dev-2, Reviewer, Debugger, DevOps, Free Roam.

## Office Location

All office files are in `ai-dev-office/` at the workspace root.

**Cursor:** Use `.cursor/rules/ai-dev-office.mdc` (always-on) plus optional `.cursor/rules/ai-dev-office-<role>.mdc`; subagents in `.cursor/agents/ai-dev-office-<role>.md` when using Cursor Agent subagents. Full role text stays in `agents/*.md`.

## Team (v2.0)

| Agent | File | Job |
|-------|------|-----|
| PM | `agents/pm.md` | Creates tasks, plans work, assigns to Dev/Dev-2 |
| Dev | `agents/dev.md` | Focused implementation |
| Dev-2 | `agents/dev-2.md` | Senior Dev for complex/cross-cutting work |
| Reviewer | `agents/reviewer.md` | Code review + build/test verification |
| Debugger | `agents/debugger.md` | Root cause analysis and fixes |
| DevOps | `agents/devops.md` | Docker, CI/CD, deployment, infra |
| Free Roam | `agents/free-roam.md` | Incident commander, unblocks pipeline |

## Agent Permissions

Each agent has a strict operating scope. Do not act outside your assigned role unless the task explicitly scopes that work.

| Agent | Allowed | Not Allowed |
|-------|---------|-------------|
| PM | Create tasks, define scope, plan subtasks, assign agents | Writing production code, infra changes, or direct implementation |
| Dev | Modify scoped application code, tests, and contract-related files in assigned scope | Infra-only changes, broad architecture changes, or out-of-scope cross-service edits |
| Dev-2 | Handle complex or cross-service code within explicit task scope | Ignoring scope boundaries or changing architecture without justification |
| Reviewer | Review artifacts, run build/tests, enforce rules, approve or reject | Modifying code directly |
| Debugger | Investigate failures and apply minimal scoped fixes | Broad refactors, speculative redesigns, or unrelated cleanup |
| DevOps | Modify Docker, CI/CD, deployment, environment, and build tooling | Changing business logic unless explicitly included in task scope |
| Free Roam | Split, reroute, unblock, or apply targeted fixes when needed | Repeating the same failed loop or bypassing baseline rules in `AGENTS.md` |

### Permission Rules

- `AGENTS.md` is the baseline source of truth for repo-wide rules.
- Agents must work only within the services and files explicitly listed in task scope.
- Cross-service changes require explicit scope in `task.md` or PM assignment.
- If a task requires work outside the current agent's role, route to the correct agent instead of improvising.
- When in doubt, escalate to `free-roam` rather than violating role boundaries.

## Flow

```
User Request -> PM -> Dev/Dev-2 -> Reviewer -> Done
                                     |    |
                                (reject) (infra)
                                     |    |
                                 Debugger DevOps
```

## Retry And Loop Control

The AI Dev Office must not loop indefinitely between implementation and review stages.

- Every task is subject to `loop_guard.max_iterations`.
- Default loop limit is `5` iterations per task.
- Repeated cycles such as `Reviewer -> Debugger -> Dev -> Reviewer` must not continue indefinitely.
- When the loop limit is exceeded, escalate to `free-roam` with the blocker `Loop guard triggered: exceeded max_iterations`.
- If Reviewer and Debugger produce conflicting conclusions across consecutive iterations, escalate to `free-roam` instead of continuing the same loop.
- Agents must read `status.yaml` before acting and respect the current iteration count.

## How to Use

### Create a new task (via PM)

```bash
./ai-dev-office/run-agent.sh TASK-NNN pm
```

PM creates `task.md`, `status.yaml`, plans subtasks, and assigns to Dev/Dev-2.

### Run an agent manually

```bash
./ai-dev-office/run-agent.sh TASK-NNN dev          # run Dev
./ai-dev-office/run-agent.sh TASK-NNN dev-2        # run Dev-2
./ai-dev-office/run-agent.sh TASK-NNN reviewer     # run Reviewer
./ai-dev-office/run-agent.sh TASK-NNN devops       # run DevOps
```

### Run full pipeline automatically

```bash
./ai-dev-office/run-agent.sh TASK-NNN auto
```

### Switch runner

```bash
./ai-dev-office/run-agent.sh TASK-NNN dev copilot  # GitHub Copilot
./ai-dev-office/run-agent.sh TASK-NNN dev codex    # Codex CLI
```

### In Cursor

When working in Cursor, read the agent prompt file directly and follow its contract:

1. Read `ai-dev-office/agents/<agent>.md` for role and output format
2. Read `ai-dev-office/runs/<task-id>/task.md` for task details
3. Read `ai-dev-office/runs/<task-id>/status.yaml` for current state
4. Produce output following the agent's Output Contract
5. Save output to `ai-dev-office/runs/<task-id>/<agent>-output.yaml`

### Check task status

Read `ai-dev-office/runs/<task-id>/status.yaml` to see current phase, iteration, and history.

### Validate runtime files

Run:

```bash
ruby ai-dev-office/validate-yaml.rb TASK-NNN
```

Use this after saving `status.yaml` or any `<agent>-output.yaml` file to catch malformed YAML, missing required fields, invalid `next_action.agent` values, or task state drift.

### Migrate legacy runtime files

Run:

```bash
ruby ai-dev-office/migrate-legacy-runtime.rb ai-dev-office/runs/TASK-011/reviewer-output.yaml
```

Use this when an older runtime file predates the current v2 output contract. The helper currently upgrades legacy `reviewer-output.yaml` files into the structured reviewer format expected by the validator. You can also pass a task directory such as `TASK-011`. Add `--write` to overwrite supported files after review.

## Key Files

- `office.config.yaml` -- agent registry and runner config
- `workflows/hybrid-default.yaml` -- orchestration rules
- `run-agent.sh` -- CLI runner script
- `validate-yaml.rb` -- runtime validator for status and agent output YAML
- `migrate-legacy-runtime.rb` -- helper to upgrade selected legacy runtime YAML files
- `../AGENTS.md` -- baseline repo-wide rules for humans and AI agents
- `schemas/` -- validation schemas for status, structured task payloads, and agent handoff outputs
- `runs/<task-id>/` -- task runtime data
- `tasks/templates/new-task.yaml` -- task template (legacy, PM creates tasks now)

## Handoff Contract

Every agent output must include: `summary`, `artifacts`, `next_action`, `blockers`.

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

## Flow

```
User Request -> PM -> Dev/Dev-2 -> Reviewer -> Done
                                     |    |
                                (reject) (infra)
                                     |    |
                                 Debugger DevOps
```

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

## Key Files

- `office.config.yaml` -- agent registry and runner config
- `workflows/hybrid-default.yaml` -- orchestration rules
- `run-agent.sh` -- CLI runner script
- `runs/<task-id>/` -- task runtime data
- `tasks/templates/new-task.yaml` -- task template (legacy, PM creates tasks now)

## Handoff Contract

Every agent output must include: `summary`, `artifacts`, `next_action`, `blockers`.

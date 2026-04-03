# AI Dev Office

A multi-agent orchestration framework that simulates a real dev team of 7 AI agents working together -- PM, Dev, Dev-2, Reviewer, Debugger, DevOps, and Free Roam -- with automatic task handoff.

## Quick Start

### 1. Start a new task via PM

```bash
TASK_ID="TASK-011"
./ai-dev-office/run-agent.sh $TASK_ID pm
```

PM will create `task.md`, `status.yaml`, plan the work, and assign it to Dev or Dev-2.

### 2. Run the assigned Dev agent

```bash
./ai-dev-office/run-agent.sh $TASK_ID dev
# or for parallel work:
./ai-dev-office/run-agent.sh $TASK_ID dev-2
```

### 3. Run Reviewer

```bash
./ai-dev-office/run-agent.sh $TASK_ID reviewer
```

Reviewer reads ALL dev outputs (both `dev-output.yaml` and `dev-2-output.yaml` if they exist), runs build/test checks, and approves or requests changes.

### 4. Auto Pipeline (runs full flow)

```bash
./ai-dev-office/run-agent.sh $TASK_ID auto
```

Runs PM -> Dev -> Reviewer -> Done automatically, with divergence to Debugger/DevOps/Free Roam as needed.

---

## Agents

| Agent | Role | Routes to |
|-------|------|-----------|
| **PM** | Creates tasks, plans work, assigns to Dev agents | Dev / Dev-2 (ready) / Free Roam (unclear) |
| **Dev** | Writes/modifies code for focused tasks | Reviewer |
| **Dev-2** | Senior Dev for complex, cross-cutting work | Reviewer |
| **Reviewer** | Reviews code + runs build/tests | Done (approved) / Debugger (rejected) / DevOps (infra fail) / Free Roam (escalate) |
| **Debugger** | Root-cause analysis and fixes | Dev (fix applied) / Free Roam (low confidence) |
| **DevOps** | Docker, CI/CD, deployment, infra | Reviewer (fixed) / Dev (code issue) / Free Roam (stuck) |
| **Free Roam** | Senior-level cross-functional solver | Dev / PM / any agent / Done (abort) |

## Workflow

```
User Request -> PM -> Dev/Dev-2 -> Reviewer -> Done
                 |       \             |
            (unclear)  Dev-2        (rejected)     (infra)
                 |    (parallel)      |               |
                 v        |           v               v
             Free Roam   |        Debugger         DevOps
                          |           |               |
                          |           v               v
                          +-----> Dev (retry)     Reviewer (retry)

Free Roam can reroute to any agent or send back to PM to re-split.
```

## Runbooks

### New Feature

1. Tell PM what you want: `./run-agent.sh TASK-011 pm`
2. PM creates task, plans subtasks, assigns Dev/Dev-2
3. Expected path: PM -> Dev -> Reviewer -> Done

### Urgent Bugfix

1. Tell PM with priority critical
2. PM assigns directly to Dev or Dev-2
3. Expected path: PM -> Dev -> Reviewer -> Done

### Infrastructure / DevOps Task

1. Tell PM about the infra need
2. PM assigns to DevOps (via `type: devops`)
3. Expected path: PM -> DevOps -> Reviewer -> Done

### Parallel Development

1. PM splits task into subtasks for Dev and Dev-2
2. Run both in separate terminals
3. Both outputs are collected by Reviewer in a single review

---

## Runners

### Priority Order

| # | Runner | Type | Best For |
|---|--------|------|----------|
| 1 | **GitHub Copilot** | CLI (default) | Straightforward tasks, scripted pipelines |
| 2 | **Cursor** | IDE (interactive) | Complex/interactive tasks, code navigation |
| 3 | **Codex CLI** | CLI | Heavy autonomous work, full-auto mode |

### Usage

```bash
./ai-dev-office/run-agent.sh TASK-011 dev              # Copilot (default)
./ai-dev-office/run-agent.sh TASK-011 dev codex         # Force Codex
./ai-dev-office/run-agent.sh TASK-011 dev cursor        # Generate prompt for Cursor
```

For Cursor: open the IDE and reference `@ai-dev-office/agents/<agent>.md` in chat, or use the generated `.cursor-prompt.md`.

### Mixing Runners

All runners share the same task files (`runs/<task-id>/`), so you can mix freely:

- Dev on Copilot + Dev-2 on Cursor (different agents, same task)
- TASK-011 on Copilot + TASK-012 on Codex (different tasks)
- PM on Cursor -> Dev on Copilot -> Reviewer on Codex (sequential handoff)

**Do not** run the same agent on the same task with multiple runners simultaneously — they would overwrite each other's output file.

### Auto-switch

When a runner fails with quota/auth errors, the system suggests the next runner in priority order. Watched patterns: `insufficient_quota`, `quota exceeded`, `rate limit`, `unauthorized`, `invalid api key`, `token expired`.

---

## Directory Structure

```
ai-dev-office/
  office.config.yaml      # Main configuration (v2.0)
  SKILL.md                # Cursor/Codex skill for auto-detection
  README.md               # This file
  run-agent.sh             # Single-terminal runner script
  agents/
    pm.md                  # PM agent prompt + contract
    dev.md                 # Dev agent prompt + contract
    dev-2.md               # Dev-2 (Senior) agent prompt + contract
    reviewer.md            # Reviewer agent prompt + contract (includes build/test)
    debugger.md            # Debugger agent prompt + contract
    devops.md              # DevOps agent prompt + contract
    free-roam.md           # Free Roam agent prompt + contract
  workflows/
    hybrid-default.yaml    # Default hybrid orchestration workflow (v2.0)
  runners/
    copilot.yaml           # GitHub Copilot CLI runner config (primary)
    cursor.yaml            # Cursor IDE runner config (secondary)
    codex.yaml             # Codex CLI runner config (tertiary)
  tasks/
    templates/
      new-task.yaml        # Task template (legacy, PM creates tasks now)
  runs/
    <task-id>/
      task.md              # Task description (created by PM)
      status.yaml          # Current state (created by PM)
      pm-output.yaml       # PM's plan and assignment
      meta.yaml            # Runner switches, timing
      <agent>-output.yaml  # Each agent's output
```

## Legacy Agents

The following agents existed in v1.0 and have been replaced:

| v1.0 Agent | Replaced by | Reason |
|------------|-------------|--------|
| Planner | **PM** | PM does everything Planner did + creates tasks + assigns work |
| Tester | **Reviewer** + **DevOps** | Reviewer now runs build/tests; DevOps handles infra issues |

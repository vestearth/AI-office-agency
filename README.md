# AI Dev Office

A multi-agent orchestration framework that simulates a real dev team of 7 AI agents working together -- PM, Dev, Dev-2, Reviewer, Debugger, DevOps, and Free Roam -- with automatic task handoff.

All contributors and AI agents must follow the baseline rules in `../AGENTS.md`.

**Cursor:** Project rules in `.cursor/rules/ai-dev-office.mdc` tie the IDE agent to this workflow (role prompts remain the single source of truth in `agents/*.md`); optional per-role rules are `ai-dev-office-<role>.mdc` for the rule picker. **Subagents** (Cursor Agent, when enabled): `.cursor/agents/ai-dev-office-*.md` — one file per role; each delegates to the matching file under `ai-dev-office/agents/`.

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

Reviewer reads all dev outputs (both `dev-output.yaml` and `dev-2-output.yaml` if they exist), verifies scope and architecture rules from `AGENTS.md`, runs build and test checks, and approves or requests changes.

### 4. Auto Pipeline (runs full flow)

```bash
./ai-dev-office/run-agent.sh $TASK_ID auto
```

Runs PM -> Dev -> Reviewer -> Done automatically, with divergence to Debugger/DevOps/Free Roam as needed.

### Validate runtime files

```bash
ruby ai-dev-office/validate-yaml.rb TASK-011
```

Use this after saving `status.yaml` or any `<agent>-output.yaml` file to catch missing required fields, invalid routing agents, or malformed runtime YAML.

### Migrate legacy runtime files

```bash
ruby ai-dev-office/migrate-legacy-runtime.rb ai-dev-office/runs/TASK-011/reviewer-output.yaml
```

This helper currently supports legacy `reviewer-output.yaml` files that predate the structured `build_check` and `artifacts` fields. You can also pass a task directory such as `TASK-011`. Add `--write` to overwrite supported files in place after reviewing the generated YAML.

---

## Agents

- **PM**: Creates tasks, plans work, assigns to Dev agents. Routes to Dev / Dev-2 (ready) / Free Roam (unclear).
- **Dev**: Writes/modifies code for focused tasks. Routes to Reviewer.
- **Dev-2**: Senior Dev for complex, cross-cutting work. Routes to Reviewer.
- **Reviewer**: Reviews code + runs build/tests. Routes to Done (approved) / Debugger (rejected) / DevOps (infra fail) / Free Roam (escalate).
- **Debugger**: Root-cause analysis and targeted fixes. Routes to Reviewer (fix applied) / Dev (more implementation needed) / Free Roam (low confidence).
- **DevOps**: Docker, CI/CD, deployment, infra. Routes to Reviewer (fixed) / Dev (code issue) / Free Roam (stuck).
- **Free Roam**: Senior-level cross-functional solver. Routes to Dev / PM / any agent / Done (abort).

## Workflow

```text
User Request -> PM -> Dev/Dev-2 -> Reviewer -> Done
                 |       \             |
            (unclear)  Dev-2        (rejected)     (infra)
                 |    (parallel)      |               |
                 v        |           v               v
             Free Roam   |        Debugger         DevOps
                         |           |               |
                         |           +-----> Reviewer (fix applied)
                         |           |
                         |           +-----> Dev (more work needed)
                         |                           |
                         +---------------------------+-----> Reviewer (retry)

Free Roam can reroute to any agent or send back to PM to re-split.
```

## Baseline Rules

The source of truth for repo-wide rules is `../AGENTS.md`. In particular, every runner and agent must follow:

- Service architecture rules: internal sync via `gRPC`, external access through `api-gateway`, async messaging via `RabbitMQ`
- Isolation rules: no cross-service database access and no shared mutable state outside APIs or events
- Naming conventions: `games-labs-<domain>`, `<Domain>Service`, `gameslabs.<domain>.v1`, and `<domain>.<action>`
- Contract rules: define or update `.proto` first for contract changes, keep changes backward compatible when possible, and version breaking changes
- Safety rules: no hardcoded secrets, no committed `.env` files, no duplicate shared logic, no unnecessary dependencies
- Definition of done: build passes, tests pass or are explicitly skipped for a valid reason, lint passes when applicable, and required proto or generated artifacts are updated

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

1. **GitHub Copilot** — Type: CLI (default), Best for: straightforward tasks and scripted pipelines
1. **Cursor** — Type: IDE (interactive), Best for: complex/interactive tasks and code navigation
1. **Codex CLI** — Type: CLI, Best for: heavy autonomous work and full-auto mode

### Usage

```bash
./ai-dev-office/run-agent.sh TASK-011 dev              # Copilot (default)
./ai-dev-office/run-agent.sh TASK-011 dev codex         # Force Codex
./ai-dev-office/run-agent.sh TASK-011 dev cursor        # Generate prompt for Cursor
```

For Cursor: open the IDE, read `ai-dev-office/agents/<agent>.md`, read the task files under `ai-dev-office/runs/<task-id>/`, and follow the output contract strictly. You can also use the generated `.cursor-prompt.md`.

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

```text
ai-dev-office/
  office.config.yaml      # Main configuration (v2.0)
  SKILL.md                # Cursor/Codex skill for auto-detection
  README.md               # This file
  run-agent.sh            # Single-terminal runner script
  validate-yaml.rb        # Runtime validator for status and agent output YAML
  migrate-legacy-runtime.rb  # Helper to upgrade selected legacy runtime YAML files
  schemas/
    status.schema.yaml        # Validation schema for runs/<task-id>/status.yaml
    task.schema.yaml          # Structured PM task blueprint schema
    agent-output.schema.yaml  # Base schema for <agent>-output.yaml handoff files
    pm-output.schema.yaml     # PM-specific task and assignment schema
    dev-output.schema.yaml    # Dev routing schema
    dev-2-output.schema.yaml  # Dev-2 routing schema
    reviewer-output.schema.yaml  # Reviewer verdict and build/test schema
    debugger-output.schema.yaml  # Debugger diagnosis schema
    devops-output.schema.yaml    # DevOps infra verification schema
    free-roam-output.schema.yaml # Free Roam decision schema
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

- `Planner` -> **PM**: PM does everything Planner did + creates tasks + assigns work.
- `Tester` -> **Reviewer** + **DevOps**: Reviewer now runs build/tests; DevOps handles infra issues.

Legacy prompt files may still exist for reference, but the active v2 workflow uses `pm`, `dev`, `dev-2`, `reviewer`, `debugger`, `devops`, and `free-roam`.

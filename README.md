# AI Dev Office

A multi-agent orchestration framework that simulates a real dev team of 7 AI agents working together — Planner, Dev, Dev-2, Reviewer, Debugger, Tester, and Free Roam — with automatic task handoff.

## Quick Start

### 1. Create a new task

Copy the template and fill in the details:

```bash
TASK_ID="TASK-001"
mkdir -p ai-dev-office/runs/$TASK_ID
cp ai-dev-office/tasks/templates/new-task.yaml ai-dev-office/runs/$TASK_ID/task.md
```

Edit `ai-dev-office/runs/$TASK_ID/task.md` with the task details, acceptance criteria, and target service.

### 2. Initialize task status

```bash
cat > ai-dev-office/runs/$TASK_ID/status.yaml << 'EOF'
phase: pending
iteration: 0
current_agent: planner
current_runner: codex
history: []
EOF
```

### 3. Run the Planner agent (first step)

```bash
codex -p "$(cat ai-dev-office/agents/planner.md)

--- TASK ---
$(cat ai-dev-office/runs/$TASK_ID/task.md)

--- STATUS ---
$(cat ai-dev-office/runs/$TASK_ID/status.yaml)

Produce your output following the Output Contract in your role definition."
```

Save the Planner output, then run the Dev agent with the plan attached:

```bash
codex -p "$(cat ai-dev-office/agents/dev.md)

--- TASK ---
$(cat ai-dev-office/runs/$TASK_ID/task.md)

--- STATUS ---
$(cat ai-dev-office/runs/$TASK_ID/status.yaml)

--- PLANNER OUTPUT ---
$(cat ai-dev-office/runs/$TASK_ID/planner-output.yaml)

Produce your output following the Output Contract in your role definition."
```

### 4. Save agent output and advance

After each agent completes, save its output to the run folder:

```bash
# Save the agent's output
# (paste or pipe the agent's YAML output into this file)
cat > ai-dev-office/runs/$TASK_ID/dev-output.yaml << 'EOF'
<agent output here>
EOF

# Update status.yaml with new phase and iteration
```

### 5. Run the next agent

Read `next_action.agent` from the previous output, then invoke that agent:

```bash
NEXT_AGENT="reviewer"  # from previous output's next_action.agent

codex -p "$(cat ai-dev-office/agents/$NEXT_AGENT.md)

--- TASK ---
$(cat ai-dev-office/runs/$TASK_ID/task.md)

--- STATUS ---
$(cat ai-dev-office/runs/$TASK_ID/status.yaml)

--- PREVIOUS AGENT OUTPUT ---
$(cat ai-dev-office/runs/$TASK_ID/dev-output.yaml)

Produce your output following the Output Contract in your role definition."
```

Repeat until `next_action.agent` is `done`.

---

## Agents

| Agent | Role | Routes to |
|-------|------|-----------|
| **Planner** | Analyzes task and creates technical plan | Dev (plan ready) / Free Roam (unclear scope) |
| **Dev** | Writes/modifies code following the plan | Reviewer |
| **Dev-2** | Senior Dev for parallel subtasks or complex work | Reviewer |
| **Reviewer** | Reviews code quality | Tester (approved) / Debugger (rejected) / Free Roam (escalate) |
| **Debugger** | Root-cause analysis and fixes | Dev (fix applied) / Free Roam (low confidence) |
| **Tester** | Runs tests and validates | Done (pass) / Debugger (fail) / Free Roam (env issue) |
| **Free Roam** | Senior-level cross-functional solver | Dev / Reviewer / any agent / Done (abort) |

## Workflow

The default workflow is `hybrid-default` (see `workflows/hybrid-default.yaml`):

```
TaskAssigned -> Planner -> Dev -----> Reviewer -> Tester -> Done
                  |          \           |            |
             (unclear)    Dev-2 ----+  (rejected)   (code fail)
                  |       (parallel) |    |            |
                  v                  |    v            v
              Free Roam              | Debugger <------+
                                     |    |
                                     |    v
                                     +- Dev (retry)

Parallel mode:
  - Planner splits task into subtasks
  - Dev handles odd subtasks, Dev-2 handles even subtasks
  - Both feed into the same Reviewer stage

Any stage can escalate to Free Roam when:
  - Planner cannot determine scope (unclear requirements)
  - Conflicting conclusions between agents
  - Flaky/env test failures
  - Loop guard triggered (>5 iterations)
  - Scope too large to proceed
```

## Runbooks

### New Feature

1. Create task with `type: feature`
2. Fill acceptance criteria with clear, testable requirements
3. Start with Planner agent -> automatic flow through pipeline
4. Expected path: Planner -> Dev -> Reviewer -> Tester -> Done

### Urgent Bugfix

1. Create task with `type: bugfix`, `priority: critical`
2. Include error logs, stack traces, or reproduction steps in description
3. Start with Dev agent (or Debugger if root cause is unclear)
4. Expected path: Planner -> Debugger -> Dev -> Reviewer -> Tester -> Done

### Flaky Test Investigation

1. Create task with `type: investigation`
2. Include test name, failure frequency, and environment details
3. Start with Free Roam agent directly
4. Free Roam will diagnose and route appropriately

---

## Fallback: Codex CLI -> GitHub Copilot

When Codex CLI quota is exhausted, the system switches to GitHub Copilot CLI. See the [Fallback Guide](#fallback-to-github-copilot) section below.

### Detecting Quota Exhaustion

The orchestrator watches for these patterns in Codex CLI output:

- `insufficient_quota`
- `quota exceeded`
- `rate limit` (after retry threshold)
- `unauthorized` / `invalid api key` / `token expired`

### Switching to Copilot

```bash
NEXT_AGENT="dev"  # or whatever agent is next

gh copilot suggest -t shell "$(cat ai-dev-office/agents/$NEXT_AGENT.md)

--- TASK ---
$(cat ai-dev-office/runs/$TASK_ID/task.md)

--- STATUS ---
$(cat ai-dev-office/runs/$TASK_ID/status.yaml)

Produce your output following the Output Contract in your role definition."
```

### Manual Override

Force Copilot from the start:

```bash
# Set runner to copilot in status.yaml
cat > ai-dev-office/runs/$TASK_ID/status.yaml << 'EOF'
phase: pending
iteration: 0
current_agent: dev
current_runner: copilot
history: []
EOF
```

### Resuming Across Runners

The handoff contract (`summary`, `artifacts`, `next_action`, `blockers`) is runner-agnostic. When switching from Codex to Copilot mid-task:

1. The task state is already persisted in `runs/<task-id>/`
2. Pass the same `task.md` + `status.yaml` + previous output to the new runner
3. The agent prompt is identical — only the CLI command changes
4. Log the switch reason in `runs/<task-id>/meta.yaml`

---

## Directory Structure

```
ai-dev-office/
  office.config.yaml      # Main configuration
  README.md               # This file
  agents/
    planner.md             # Planner agent prompt + contract
    dev.md                 # Dev agent prompt + contract
    dev-2.md               # Dev-2 (Senior) agent for parallel subtasks
    reviewer.md            # Reviewer agent prompt + contract
    debugger.md            # Debugger agent prompt + contract
    tester.md              # Tester agent prompt + contract
    free-roam.md           # Free Roam agent prompt + contract
  workflows/
    hybrid-default.yaml    # Default hybrid orchestration workflow
  runners/
    codex.yaml             # Codex CLI runner config
    copilot.yaml           # GitHub Copilot CLI runner config
  tasks/
    templates/
      new-task.yaml        # Task template
  runs/                    # Runtime task data (gitignored for sensitive runs)
    <task-id>/
      task.md              # Task description
      status.yaml          # Current state
      meta.yaml            # Runner switches, timing
      <agent>-output.yaml  # Each agent's output
```

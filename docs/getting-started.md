# Getting Started

Commands assume the framework lives at `ai-dev-office/` relative to your workspace root.

## First task

```bash
TASK_ID="TASK-011"
./ai-dev-office/run-agent.sh $TASK_ID pm
./ai-dev-office/run-agent.sh $TASK_ID dev
./ai-dev-office/run-agent.sh $TASK_ID reviewer
```

PM creates `runs/<task-id>/task.md` and `status.yaml`, plans work, and assigns Dev or Dev-2.
If upstream work is required, PM sets `phase: blocked` with `blocked_on`, `waiting_for`, and `ready: false`.

## Auto pipeline

```bash
./ai-dev-office/run-agent.sh $TASK_ID auto
```

Runs PM → Dev → Reviewer → Done with routing to Debugger, DevOps, or Free Roam when needed.
Auto mode stops on blocked tasks instead of dispatching downstream agents.

When PM sets `assignment.parallel: true` with valid parallel subtasks (`parallel_safe: true`,
non-overlapping owned files, distinct `dev` and `dev-2` lanes), auto mode runs both dev agents
concurrently, writes `dev-parallel.log` and `dev-2-parallel.log`, then routes to Reviewer.
See `workflows/hybrid-default.yaml` and `tests/integration/auto-parallel.sh`.

## Profiles

```bash
./ai-dev-office/run-agent.sh --profile generic TASK-011 pm
OFFICE_PROFILE=games-labs ./ai-dev-office/run-agent.sh TASK-011 reviewer
```

See `docs/config-profile-merge-contract.md` and `profiles/README.md`.

## Validate runtime files

```bash
ruby ai-dev-office/validate-yaml.rb TASK-011
```

Run after saving `status.yaml` or any `<agent>-output.yaml` to catch missing fields,
invalid routing, malformed YAML, and `phase` vs `state` mismatches.

## Status command

```bash
./ai-dev-office/run-agent.sh status
./ai-dev-office/run-agent.sh status TASK-011
```

Read-only summary of phase, routed agent, readiness, blocked dependencies, validation state,
and suggested next command. Task ids may use `TASK-NNN`, `TASK-PKG-NNN`, or a per-user namespace `TASK-<PREFIX>-NNN` (see docs/multi-user-git.md).

## Operator helpers

```bash
./ai-dev-office/run-agent.sh intake "Fix wallet callback failure"
./ai-dev-office/run-agent.sh verify TASK-011
./ai-dev-office/run-agent.sh cleanup
```

Non-mutating in v2. Skill guides: `docs/skills/office-intake.md`, `docs/skills/office-verify.md`, `docs/skills/office-cleanup.md`.

## Bootstrap a target project

```bash
./ai-dev-office/scripts/bootstrap-project.sh --target ../target-project --profile generic
./ai-dev-office/scripts/sync-to-project.sh --target ../target-project --profile games-labs
```

Creates starter project files and refreshes installed framework files per `templates/install-manifest.yaml`.
Does not copy runtime task history, logs, or local machine config by default.

## Scaffold and migrate

```bash
./ai-dev-office/run-agent.sh TASK-011 scaffold dev
./ai-dev-office/run-agent.sh TASK-011 scaffold reviewer --force
ruby ai-dev-office/migrate-legacy-runtime.rb ai-dev-office/runs/TASK-011/reviewer-output.yaml
```

## Agents and workflow

| Agent | Role |
|-------|------|
| PM | Creates tasks, plans, assigns Dev/Dev-2 |
| Dev / Dev-2 | Implementation; hand off to Reviewer (`in_review`) |
| Reviewer | Review, build/test; route to Done, Debugger, DevOps, or Free Roam |
| Debugger | Root-cause fixes |
| DevOps | Docker, CI/CD, deployment |
| Free Roam | Escalation and unblocking |

```text
User Request -> PM -> Dev/Dev-2 -> Reviewer -> Done
                 |       \             |
            (unclear)  Dev-2        (rejected)     (infra)
                 |    (parallel)      |               |
                 v        |           v               v
             Free Roam   |        Debugger         DevOps
```

### Runtime state

- `phase` and `state` should stay aligned; `in_review` is the reviewer queue after Dev handoff
- `blocked` + `blocked_on` / `waiting_for` / `ready: false` gate dispatch
- `current_agent` is enforced by `run-agent.sh`
- `iteration` vs `office.config.yaml -> loop_guard.max_iterations` (default 8) escalates to Free Roam
- `runs/` is runtime state and should stay gitignored except for `runs/.gitkeep`

## Runbooks

| Scenario | Path |
|----------|------|
| New feature | PM → Dev → In Review → Done |
| Urgent bugfix | PM (critical) → Dev → In Review → Done |
| Infra task | PM → DevOps → In Review → Done |
| Parallel dev | PM parallel plan → dev + dev-2 → Reviewer |

Target-project architecture and naming rules belong in the **target project's** `AGENTS.md`, not this framework doc.

## Integration tests

```bash
ai-dev-office/tests/integration/contract-foundation.sh
ai-dev-office/tests/integration/status-command.sh
ai-dev-office/tests/integration/bootstrap-sync.sh
ai-dev-office/tests/integration/profile-merge.sh
```

Full list: see [README.md](../README.md#integration-tests).

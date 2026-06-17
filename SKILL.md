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

Seven agents (PM, Dev, Dev-2, Reviewer, Debugger, DevOps, Free Roam) with YAML handoffs under `ai-dev-office/runs/<task-id>/`.

AI Dev Office coordinates the workflow and records the verification trail. It
does not replace current repository files, tests, CI, logs, runtime config, API
contracts, or actual runtime behavior as source of truth.

This file is only the entrypoint. Before acting on runner, profile, Cursor, or SocratiCode behavior, follow the linked guide for that topic.

Must-read runtime anchors:
- Role prompts in `agents/*.md` are authoritative.
- Task state in `runs/<task-id>/status.yaml` is the AI Dev Office run-state record.
- Use linked docs before changing runner, profile, Cursor, or SocratiCode behavior.

## Docs (read these first)

| Guide | When |
|-------|------|
| [docs/getting-started.md](docs/getting-started.md) | First task, auto, status, validate |
| [docs/codex.md](docs/codex.md) | Codex CLI (default runner) |
| [docs/cursor.md](docs/cursor.md) | Cursor CLI Agent or Cursor IDE |
| [docs/claude.md](docs/claude.md) | Claude manual advisory lane |
| [docs/gemini.md](docs/gemini.md) | Gemini manual advisory lane |
| [docs/cursor-templates.md](docs/cursor-templates.md) | `.cursor/rules` / `.cursor/agents` |
| [docs/socraticode.md](docs/socraticode.md) | Indexed discovery (env-based paths) |
| [profiles/README.md](profiles/README.md) | `--profile` selection |
| [AGENTS.md](AGENTS.md) | Framework portability rules |

Runner set stays unchanged: `codex`, `cursor-agent`, and `cursor` remain the only configured runtime runners. Claude and Gemini stay manual advisory lanes.

## Minimal commands

```bash
./ai-dev-office/run-agent.sh TASK-NNN pm
./ai-dev-office/run-agent.sh TASK-NNN dev
./ai-dev-office/run-agent.sh TASK-NNN auto
./ai-dev-office/run-agent.sh status TASK-NNN
ruby ai-dev-office/validate-yaml.rb TASK-NNN
```

Profile example: `./ai-dev-office/run-agent.sh --profile generic TASK-NNN reviewer`

## Cursor session

1. Read `agents/<role>.md` for Output Contract
2. Read `runs/<task-id>/task.md` and `status.yaml`
3. Save `runs/<task-id>/<role>-output.yaml`
4. Run `validate-yaml.rb`

Rules/subagents: [docs/cursor-templates.md](docs/cursor-templates.md). Role text stays in `agents/*.md`.

## Key paths

- `run-agent.sh` — CLI entry (supports `--profile` / `OFFICE_PROFILE`)
- `agents/*.md` — role prompts (authoritative)
- `office.config.example.yaml` — portable config template
- `validate-yaml.rb` — runtime YAML validator

Integration tests: [README.md](README.md#integration-tests).

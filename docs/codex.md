# Codex Runner Guide

Source of truth for command templates: `runners/codex.yaml`.

## Purpose and priority

| Field | Value |
|-------|-------|
| Purpose | Autonomous implementation, patch, refactor, and test runner |
| Priority | **1st** (default) |
| Selected when | No runner arg, or explicit `codex` |
| Fallback | `cursor-agent` → `cursor` on quota/auth failures |

Runner priority is configured in `office.config.yaml` under `runner_selector.priority`.

Codex must execute against the real repository using source evidence, selected
ai-skills, project `AGENTS.md`, current tests/checks, and verification results.
It must not treat SocratiCode, run records, or historical notes as final truth.

## Basic usage

```bash
./ai-dev-office/run-agent.sh TASK-011 dev              # Codex (default)
./ai-dev-office/run-agent.sh TASK-011 dev codex         # explicit
./ai-dev-office/run-agent.sh TASK-011 auto              # full pipeline
./ai-dev-office/run-agent.sh --profile games-labs TASK-011 reviewer
```

## Auto pipeline

`./run-agent.sh TASK-NNN auto` runs PM, then Dev (or parallel dev lanes), then Reviewer.
It respects blocked tasks, loop guard, and dependency guard (when enabled by profile/config).

Auto-switch: on failures matching `runner_selector.trigger_patterns` (`insufficient_quota`, `quota exceeded`, `rate limit`, `unauthorized`, `invalid api key`, `token expired`), the runner retries then switches to the next runner in priority order.

## Output contract

Each agent writes `runs/<task-id>/<agent>-output.yaml` per the role's Output Contract in `agents/<agent>.md`.
After saving output, run:

```bash
ruby ai-dev-office/validate-yaml.rb TASK-011
```

Concise Codex-first role starters: `role-prompt-templates-codex-first.md`.

## SocratiCode in Codex sessions

Use SocratiCode MCP when exposed; otherwise fall back to `scripts/socraticode-tcp-wrapper.sh` or local CLI before manual repo inspection. See [socraticode.md](socraticode.md).

## Related docs

- [getting-started.md](getting-started.md) — first task, status, validate
- [cursor.md](cursor.md) — IDE and cursor-agent fallback
- [config-profile-merge-contract.md](config-profile-merge-contract.md) — profile overlays

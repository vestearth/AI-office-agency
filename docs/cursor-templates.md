# Cursor Templates Guide

Optional Cursor integration files help IDE agents follow the AI Dev Office workflow without duplicating role prompts.

Templates live in `ai-dev-office/templates/cursor/` and install to **each developer's machine** at `<repo-root>/.cursor/` — not committed per-user copies with machine-specific paths.

## Quick install (after clone)

From the repo root that contains `ai-dev-office/`:

```bash
./ai-dev-office/scripts/install-cursor-templates.sh
```

| Flag | Purpose |
|------|---------|
| `--target <path>` | Project root (default: parent of `ai-dev-office/`) |
| `--force` | Overwrite existing `.cursor/` files |

The installer replaces `__REPO_ROOT__` in `socraticode.mdc` with the resolved target path.

Manual copy: see [templates/cursor/README.md](../templates/cursor/README.md).

## Bootstrap / sync

`bootstrap-project.sh` runs the install script automatically for new target projects.

`sync-to-project.sh` still syncs framework files under `target/ai-dev-office/`; Cursor paths remain at the **target project root** (`.cursor/`).

```bash
./ai-dev-office/scripts/bootstrap-project.sh --target ../target-project --profile generic
```

## `.cursor/rules/`

| File | Purpose |
|------|---------|
| `agent-execution.mdc` | Always read `AGENTS.md` and task context |
| `ai-dev-office.mdc` | Always-on orchestration: read `agents/*.md`, handoff YAML, validate |
| `go-mod-dependencies.mdc` | Go module policy (Games Labs monorepo) |
| `socraticode.mdc` | SocratiCode discovery routing (`__REPO_ROOT__` → local clone path on install) |
| `ai-dev-office-<role>.mdc` | Optional per-role picker entries delegating to `agents/<role>.md` |

Rules should **delegate** to `ai-dev-office/agents/*.md` — do not copy long role text into rules.

## `.cursor/agents/`

When Cursor subagents are enabled, one stub per role:

```text
.cursor/agents/ai-dev-office-pm.md
.cursor/agents/ai-dev-office-dev.md
...
```

Each stub points to the matching file under `ai-dev-office/agents/`. Subagent definitions live in the target project's `.cursor/agents/`; the framework ships templates, not machine-specific copies.

## Host-local (do not install from templates)

- `~/.cursor/mcp.json` — user-global MCP / SocratiCode backend selection
- Replace `__REPO_ROOT__` yourself only if you copy files by hand without the install script

Per `templates/install-manifest.yaml` exclude rules, do **not** copy into target projects:

- `runs/**`, task output YAML, logs, `.cursor-prompt.md`
- `office.config.local.yaml`, `profiles/*.local.yaml`, `.env`, `.socraticode.local.yaml`
- Secrets or another developer's `.cursor/` tree

## Related docs

- [cursor.md](cursor.md) — IDE and cursor-agent runner flow
- [getting-started.md](getting-started.md) — bootstrap and sync commands
- [socraticode.md](socraticode.md) — indexed navigation and MCP setup

# TASK-095: Wire SocratiCode MCP into the Claude Code lane

## Short name
`claude-socraticode-mcp-wiring`

## Type
tooling / config

## Priority
low

## Parent / Epic
- Standalone tooling change (no service code touched)

## Context

SocratiCode is already wired for Codex (`.codex/config.toml` →
`mcp_servers.socraticode` → `/Users/earth/.local/bin/socraticode-remote`),
Cursor (`.cursor/rules/socraticode.mdc`, user-global MCP), and the
ai-dev-office runners (`run-agent.sh` context_provider injection via
`scripts/socraticode-tcp-wrapper.sh`).

The Claude Code manual advisory lane (see `ai-dev-office/docs/CLAUDE.md`) had
no SocratiCode access: no `.mcp.json` at the GitHub root and no `codebase_*`
tools in session. This task wires it so Claude can use cross-service
graph/impact and semantic search when acting in reviewer/debugger-style
advisory passes.

## Scope

1. Create `/Users/earth/Documents/GitHub/.mcp.json` registering the
   `socraticode` MCP server, pointing at the same
   `/Users/earth/.local/bin/socraticode-remote` launcher Codex uses
   (SSH → 192.168.1.140 → `npx socraticode` in `D:\llm`).
2. Create `/Users/earth/Documents/GitHub/CLAUDE.md` with the Codebase-Truth
   guard mirroring `.cursor/rules/socraticode.mdc`: SocratiCode is navigation
   only, projectPath fallback order `d:\llm` → `/Users/earth/Documents/GitHub`
   (local Docker backend), read actual source before claims.
3. Smoke test backend reachability via
   `ai-dev-office/scripts/socraticode-tcp-wrapper.sh codebase_status`.

## Out of scope

- No change to `runner_selector`, `context_provider`, or any runner config —
  Claude remains a manual advisory lane, not a configured runner.
- No service code changes.

## Acceptance

- `.mcp.json` exists and points at the existing launcher (no new machine
  paths committed into framework docs).
- Guard doc exists and is consistent with AGENTS.md Codebase Truth.
- Smoke test result recorded in status.yaml (pass, or failure noted with
  fallback statement).
- New Claude Code sessions in `/Users/earth/Documents/GitHub` expose
  `codebase_*` tools after the user approves the project MCP server.

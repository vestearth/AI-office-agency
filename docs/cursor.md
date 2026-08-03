# Cursor Runner Guide

Source of truth: `runners/cursor-agent.yaml` (CLI) and `runners/cursor.yaml` (IDE).

## Runner comparison

| Runner | Priority | Type | Selected when |
|--------|----------|------|---------------|
| `cursor-agent` | 2nd | CLI | Codex fails with switchable pattern, or explicit `cursor-agent` |
| `cursor` | 3rd | IDE | Codex and cursor-agent unavailable, or explicit `cursor` |

Cursor is the interactive coding cockpit for manual assist, UI-heavy edits, and
human-in-the-loop coding. Cursor Agent and Cursor IDE must still work from
source evidence, selected ai-skills, project `AGENTS.md`, current repository
truth, tests, and verification results.

In the operator model ([AGENTS.md](../AGENTS.md)) Cursor's default role is
**subagent** — a conductor (Claude or Codex) delegates workspace-local edits to
it — while it remains a configured automated runner (`cursor-agent`, then
`cursor`) inside `run-agent.sh`. It may also conduct local-workspace tasks
directly. As an operator it is never written into a machine field; provenance goes
in free-text. (Cursor is also the intentionally un-wired ai-skills oracle lane on
this team — see knowledge-base ADR-0002; that is independent of its operator role.)

## Cursor CLI Agent

```bash
./ai-dev-office/run-agent.sh TASK-011 dev cursor-agent
```

Runs Cursor Agent from the terminal with the same task files and output contract as Codex.
Health check: `cursor agent --help`.

## Cursor IDE (interactive)

```bash
./ai-dev-office/run-agent.sh TASK-011 dev cursor
```

Generates `runs/<task-id>/.cursor-prompt.md` with role prompt, task, status, and prior context.

Then in Cursor:

1. Read `ai-dev-office/agents/<agent>.md`
2. Read `runs/<task-id>/task.md` and `status.yaml`
3. Follow the Output Contract
4. Save `runs/<task-id>/<agent>-output.yaml`
5. Run `ruby ai-dev-office/validate-yaml.rb <task-id>`

Optional: use generated `.cursor-prompt.md` or @-mention agent/task files.

## Mixing runners

All runners share `runs/<task-id>/`. You may use different runners for different agents or tasks.
**Do not** run the same agent on the same task with multiple runners simultaneously.

Examples:

- Dev on Codex + Dev-2 on Cursor (same task, different agents)
- PM on Cursor → Dev on cursor-agent → Reviewer on Codex

## Cursor rules and subagents

Install and template guidance: [cursor-templates.md](cursor-templates.md).

For session-closeout `knowledge-librarian` on Cursor, keep Auto (`model:
inherit` on the Cursor adapter). Do not force Terra/Sol; that quality-first
profile remains Codex-only — see
[workflows/knowledge-librarian.md](../workflows/knowledge-librarian.md).

## Related docs

- [codex.md](codex.md) — default runner and auto-switch
- [getting-started.md](getting-started.md) — validate and status

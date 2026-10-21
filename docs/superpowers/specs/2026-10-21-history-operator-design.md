# Record the Operator on History Rows (SPAR-32 phase 2, data source)

**Status:** design + implementation on branch `feat/history-operator-recording`, pending Earth's review. **Builds on:** knowledge-base ADR-0003 (Operator-First Conductor Model). **Out of scope:** the 3D office visuals (a separate Multica task).

## Summary

Every governed writer that appends a `status.yaml` `history[]` row adds an
optional `operator` field: the AI tool whose work wrote that row (`claude`,
`codex`, `cursor`, `antigravity` or `copilot`). The role stays in `agent`. The dashboard's derived
`RunSummary.currentConductor` reads `operator` first and falls back to the
free-text `agent` parsing it already does.

```yaml
history:
- phase: in_review -> done
  agent: reviewer          # the role contract, as before
  reason: approved
  at: '2026-10-21T10:00:00Z'
  operator: codex          # new, optional: who did the work
```

## Evidence (2026-10-21)

- `GET /api/runs`: 3 of 19 open runs have `currentConductor` (all `claude`).
  Across 575 runs: claude 62, codex 35, cursor 0, unknown 478.
- The operator is only ever recorded by hand. Census of `history[].agent`
  across `runs/`: `pm` 839, `reviewer` 562, `dev` 547 … and the operator names
  appear only in hand-written free text (`claude-advisory` 100, `codex` 39,
  `Codex conductor` 36, `claude` 15, …). No writer records one.
- The open runs' newest rows come from governed writers: `update-completion-gate.rb`
  (`gate …: a -> b`), `update-waits-on.rb`, `update-train-carries.rb`,
  `open-task.rb`. These take `--actor <role>`, and `CompletionGuard.event_agent`
  maps anything else to `orchestrator`, so the operator cannot get in.
- `history[].agent` cannot carry the operator: `run-agent.sh`'s
  `find_latest_output_for_agents` reads it as a role to pick the previous
  agent's output, and `docs/claude.md` tells conductors to write the role there.
- `run-agent.sh` knows the runner that succeeded (`$RUNNER`, after fallback)
  before it syncs `status.yaml` from the output, but never passes it on.

## Design

### The field

`history[].operator` — optional, one of `CompletionGuard::HISTORY_OPERATORS`
(`claude codex cursor antigravity copilot`: the five Multica runtimes on this
machine). It is provenance on the ADR-0003 operator axis, not a
role: the enforced role fields and `history[].agent` are unchanged. A row with
no `operator` is valid (every existing row), so nothing is backfilled.
`validate-yaml.rb` rejects any other value; `schemas/status.schema.yaml`
declares the enum and `tests/integration/schema-validator-parity.sh` pins the
two together. Adding an operator is one word in that constant, the schema enum
and the dashboard's `TIMELINE_OPERATORS`. Antigravity and Copilot have no known
harness marker yet, so they record only through the explicit variable.

### Who writes it, and which operator

One helper, `CompletionGuard.with_operator(row)`, adds the field when
`CompletionGuard.history_operator` resolves one. Every `status.yaml` history
writer uses it (the shared row builders `gate_history_row`, `gate_after_change`,
`gate_requires_record_change`, `branch_history_row`, plus each writer's own
row). Driver rows (`agent: orchestrator`: reconcile, validation_failed) are
stamped too, with the operator of the session that ran the driver; a human
decision applied by `reconcile-decision.rb` therefore names the conductor that
applied it, while `reason` still names the person. Resolution order:

1. `AI_DEV_OFFICE_HISTORY_OPERATOR`, when set. Runner names are accepted:
   `cursor-agent` → `cursor`. An unknown value is ignored with a warning (no
   field, no fallback).
2. Otherwise, the harness marker of the shell the writer runs in, innermost
   harness first:

   | Marker | Set by | Operator |
   |---|---|---|
   | `CURSOR_AGENT=1` | cursor-agent CLI for every shell command (seen in the 2026.10.19 bundle) | `cursor` |
   | `CODEX_THREAD_ID` | Codex CLI for every shell command (probed with codex-cli 0.157.1) | `codex` |
   | `CLAUDECODE=1` | Claude Code for every shell command | `claude` |

   A child inherits its parent harness's markers (the Codex probe run from
   Claude Code also saw `CLAUDECODE`), so the order follows the delegation
   direction in ADR-0003: Claude and Codex delegate to Cursor, and Claude to
   Codex through the codex plugin. The reverse nesting (Codex starting Claude)
   would be recorded as `codex`; set the explicit variable there.
3. Otherwise no field.

### How each lane records it

- **run-agent.sh dispatch (automated runner lane).** After the runner succeeds,
  `run-agent.sh` exports `AI_DEV_OFFICE_HISTORY_OPERATOR="$RUNNER"`, so the sync
  row and any guard route written about that runner's output name it, whoever
  invoked the dispatch. `codex` → `codex`; `cursor-agent` (CLI) and `cursor`
  (the interactive IDE runner, synced on the re-run after the human finishes in
  Cursor) both → `cursor`. Rows written before the runner starts (preflight
  reconcile) keep the invoker's operator.
- **Claude conductor.** Governed writers run from Claude Code's shell, so
  `CLAUDECODE=1` resolves `claude` with no setup. A row Claude writes by hand
  adds `operator: claude` itself (`docs/claude.md`).
- **Codex conductor.** Same, through `CODEX_THREAD_ID`.
- **Dashboard task steps.** `stepEnv` sets the variable to the step's CLI
  (`claude`, `codex`, `cursor-agent` → `cursor`), so a step is never credited
  to a harness the dashboard itself was started from.
- **Dashboard buttons.** `scriptEnv` strips the variable and the three markers:
  a row a person writes from the dashboard records no operator.
- **Multica.** Each agent is bound to a runtime that is one of these tools
  (`multica agent list` / `runtime list`, 2026-10-21): Claude — Michael De
  Santa, Jason Duval; Codex — Tommy Vercetti, Franklin; Cursor — Niko Belic,
  Trevor, Claude Speed. Antigravity and Copilot runtimes exist with no agent.
  The runtime CLI's own marker resolves the tool. No agent sets custom env
  today (`has_custom_env: false`); an Antigravity or Copilot agent would set
  `AI_DEV_OFFICE_HISTORY_OPERATOR` in its custom env. Which Multica agent ran
  (the character, not the tool) is not recorded; a follow-up can add it if the
  3D page needs it. Not yet seen in a live Multica run (none was running).

### Dashboard

`rowOperator(entry)` returns `entry.operator` when it is a known operator,
else the operator `classifyActor(entry.agent)` finds in legacy free text.
`latestConductor` and the Flow view's conductor counts use it, so a row with
`agent: reviewer, operator: codex` counts once as the `reviewer` role and once
as the `codex` conductor.

## Non-goals

- No backfill or rewrite of existing `runs/` history.
- No change to `history[].agent` or to any enforced role field.
- No timeline UI change (the per-row operator is not shown yet).

## Deploy and rollback

Additive and optional: old readers ignore the field, the validator accepts
rows without it, and no stored file changes until a writer runs. Rollback is a
`git revert`; rows already written keep a field the reverted validator does not
check (it never rejected unknown history keys).

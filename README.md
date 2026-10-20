# AI Dev Office

Portable workflow control plane for evidence-first AI development: PM, Dev,
Dev-2, Reviewer, Debugger, DevOps, and Free Roam with YAML handoffs, task state,
decision records, logs, validators, and verification trails.

Framework rules: [AGENTS.md](AGENTS.md). Target projects provide their own root `AGENTS.md` for product-specific policy. The operator model (conductor vs subagent vs role enum, and the lightweight-to-formal tripwire) is defined in [AGENTS.md](AGENTS.md#operator-model-conductor-and-subagent).

## Evidence-first model

AI Dev Office coordinates work and records verified decisions. It does not decide
code truth by itself. Current repository files, tests, CI, runtime logs, real
config/env, current API/product contracts, and actual runtime behavior remain
the final source of truth.

SocratiCode discovers where evidence likely lives. ai-skills define how agents
reason, review, and produce outputs. Codex and Cursor execute against the real
repository. knowledge-base stores approved durable knowledge for later reuse.

```text
Source of Truth = prove
SocratiCode = find/map
ai-skills = guide/check
Codex/Cursor = do
ai-dev-office = coordinate/record/verify
knowledge-base = remember
```

Recommended workflow:

1. Task arrives.
2. AI Dev Office creates task/run and selects lane.
3. SocratiCode discovers context, symbols, flow, and impact.
4. Agent verifies against repo files, tests, logs, config, and current contract.
5. Agent selects relevant ai-skills.
6. Codex or Cursor executes using evidence, skill guidance, and `AGENTS.md`.
7. Tests/checks/validators run.
8. AI Dev Office records result, decision, evidence, and verification.
9. Durable knowledge is suggested for capture when useful, or written only
   inside an explicitly approved product scope with an audit trail.
10. Human or approved workflow reviews and publishes knowledge-base changes.

## Framework contract

Portable defaults live in `AGENTS.md`, `office.config.example.yaml`, `templates/install-manifest.yaml`, `profiles/`, `templates/`, `agents/`, `schemas/`, and `workflows/`. Machine-specific values belong in ignored local config (`office.config.local.yaml`, `profiles/*.local.yaml`, environment variables).

Config merge: [docs/config-profile-merge-contract.md](docs/config-profile-merge-contract.md).

Verify portable assumptions: `tests/integration/contract-foundation.sh`

## Documentation

Detailed behavior lives in the linked docs; keep this README as an index.

| Doc | Contents |
|-----|----------|
| [docs/getting-started.md](docs/getting-started.md) | First task, auto pipeline, status, validate, bootstrap |
| [docs/orchestration-boundary.md](docs/orchestration-boundary.md) | `auto` as an optional local runner vs. the workflow/runtime boundary; workflow-vs-runtime classification and the task/transition contract |
| [docs/runtime-adapter-contract.md](docs/runtime-adapter-contract.md) | The stable interface an external runtime (Multica or otherwise) adapts to; the corrected Multica CLI finding; `scripts/adapter-status.rb` |
| [docs/phase4-auto-runner-decision.md](docs/phase4-auto-runner-decision.md) | The #23 Phase 4 decision, with evidence: `run-agent.sh auto` remains fully supported — no alternative execution path has proven stable enough to warrant legacy/compatibility mode or removal |
| [docs/codex.md](docs/codex.md) | Codex CLI runner (default) and co-conductor, auto-switch |
| [docs/cursor.md](docs/cursor.md) | Cursor CLI Agent / IDE runner and default subagent |
| [docs/claude.md](docs/claude.md) | Claude primary conductor (interactive lane) |
| [docs/antigravity.md](docs/antigravity.md) | Antigravity CLI research / wide-context subagent and advisory lane |
| [docs/gemini.md](docs/gemini.md) | Superseded pointer (historical Gemini naming) |
| [docs/cursor-templates.md](docs/cursor-templates.md) | `.cursor/rules` and `.cursor/agents` templates |
| [docs/socraticode.md](docs/socraticode.md) | Env/profile-based discovery flow |
| [workflows/knowledge-capture.md](workflows/knowledge-capture.md) | Suggest-only knowledge capture output for `knowledge-base/` |
| [workflows/knowledge-closeout.md](workflows/knowledge-closeout.md) | Session-closeout routing: skip, capture, librarian, or capture then librarian reconcile, with a recorded decision per pass |
| [workflows/knowledge-librarian.md](workflows/knowledge-librarian.md) | Session-closeout, weekly, or on-demand vault review with audited, policy-scoped writes |
| [profiles/README.md](profiles/README.md) | Profile selection |
| [profiles/games-labs.md](profiles/games-labs.md) | Games Lab monorepo overlay (dependency guard, shared-lib policy) |
| [SKILL.md](SKILL.md) | Codex and Cursor skill entrypoint |

Claude and Codex are the **conductors**: a human commands one of them to own a task, solo or delegating to subagents (Cursor, Antigravity CLI) — see the operator model in [AGENTS.md](AGENTS.md#operator-model-conductor-and-subagent). Inside a formal run, `run-agent.sh` selects the automated runner (Codex, then Cursor); Claude and Antigravity CLI are never automated runners there, only optional advisory passes.

## Quick commands

```bash
./ai-dev-office/run-agent.sh TASK-011 pm
./ai-dev-office/run-agent.sh TASK-011 auto
./ai-dev-office/run-agent.sh --profile generic TASK-011 dev
./ai-dev-office/run-agent.sh status TASK-011
ruby ai-dev-office/validate-yaml.rb TASK-011
```

## Integration tests

Run the full regression with `ai-dev-office/tests/run-integration.sh`. It fails a
suite unless it exits 0 **and** its last line is its `[PASS]` / `PASS:` line —
exit 0 alone is not proof, because on bash 3.2 a suite that aborts under
`set -u` can still exit 0 through its EXIT trap. Each suite also gets
`INTEGRATION_SUITE_TIMEOUT` seconds (default 600); a hung suite is stopped with
every process it spawned and reported as a failure.

Run only some suites by passing their paths:

```bash
ai-dev-office/tests/run-integration.sh ai-dev-office/tests/integration/observability.sh
```

The suites are whatever `tests/integration/*.sh` contains; this README keeps no
second list, so the list and the code cannot drift apart. Each suite's header
comment says what it checks.

Smoke: `ai-dev-office/tests/smoke/socraticode-graph.sh`

## Directory layout

```text
ai-dev-office/
  AGENTS.md                 # Framework rules (portable)
  office.config.yaml        # Active config (may be workspace-specific)
  office.config.example.yaml
  run-agent.sh
  validate-yaml.rb
  agents/                   # Role prompts (single source of truth)
  workflows/
  schemas/
  profiles/
  templates/
  scripts/
  docs/
  runs/<task-id>/           # Runtime task state (gitignored; not installed to targets)
```

Legacy v1 agent references live under `docs/legacy-v1/` for archive only. Active role prompts stay in `agents/`.

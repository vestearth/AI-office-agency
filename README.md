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

Portable defaults live in `AGENTS.md`, `office.config.example.yaml`, `templates/install-manifest.yaml`, `profiles/`, `templates/`, `runners/`, `agents/`, `schemas/`, and `workflows/`. Machine-specific values belong in ignored local config (`office.config.local.yaml`, `profiles/*.local.yaml`, environment variables).

Config merge: [docs/config-profile-merge-contract.md](docs/config-profile-merge-contract.md).

Verify portable assumptions: `tests/integration/contract-foundation.sh`

## Documentation

Detailed behavior lives in the linked docs; keep this README as an index.

| Doc | Contents |
|-----|----------|
| [docs/getting-started.md](docs/getting-started.md) | First task, auto pipeline, status, validate, bootstrap |
| [docs/codex.md](docs/codex.md) | Codex CLI runner (default) and co-conductor, auto-switch |
| [docs/cursor.md](docs/cursor.md) | Cursor CLI Agent / IDE runner and default subagent |
| [docs/claude.md](docs/claude.md) | Claude primary conductor (interactive lane) |
| [docs/gemini.md](docs/gemini.md) | Gemini subagent and advisory lane |
| [docs/cursor-templates.md](docs/cursor-templates.md) | `.cursor/rules` and `.cursor/agents` templates |
| [docs/socraticode.md](docs/socraticode.md) | Env/profile-based discovery flow |
| [workflows/knowledge-capture.md](workflows/knowledge-capture.md) | Suggest-only knowledge capture output for `knowledge-base/` |
| [workflows/knowledge-librarian.md](workflows/knowledge-librarian.md) | Weekly/on-demand vault review with audited, policy-scoped writes |
| [profiles/README.md](profiles/README.md) | Profile selection |
| [profiles/games-labs.md](profiles/games-labs.md) | Games Lab monorepo overlay (dependency guard, shared-lib policy) |
| [SKILL.md](SKILL.md) | Codex and Cursor skill entrypoint |

Claude and Gemini are documented here as manual advisory lanes only. They are not automated runners in this framework.

## Quick commands

```bash
./ai-dev-office/run-agent.sh TASK-011 pm
./ai-dev-office/run-agent.sh TASK-011 auto
./ai-dev-office/run-agent.sh --profile generic TASK-011 dev
./ai-dev-office/run-agent.sh status TASK-011
ruby ai-dev-office/validate-yaml.rb TASK-011
```

## Integration tests

```bash
ai-dev-office/tests/integration/contract-foundation.sh
ai-dev-office/tests/integration/dependency-policy.sh
ai-dev-office/tests/integration/dependency-guard.sh
ai-dev-office/tests/integration/auto-parallel.sh
ai-dev-office/tests/integration/context-provider.sh
ai-dev-office/tests/integration/operator-commands.sh
ai-dev-office/tests/integration/status-command.sh
ai-dev-office/tests/integration/runner-fallback.sh
ai-dev-office/tests/integration/bootstrap-sync.sh
ai-dev-office/tests/integration/profile-merge.sh
ai-dev-office/tests/integration/output-contract.sh
ai-dev-office/tests/integration/decision-reconcile.sh
ai-dev-office/tests/integration/driver-decision-e2e.sh
ai-dev-office/tests/integration/concurrent-status-writes.sh
ai-dev-office/tests/integration/resilience-fail-loud.sh
ai-dev-office/tests/integration/loop-guard-bounded.sh
ai-dev-office/tests/integration/validation-failed-bounded.sh
ai-dev-office/tests/integration/idempotency-and-reentry.sh
ai-dev-office/tests/integration/decision-path-integrity.sh
ai-dev-office/tests/integration/state-machine-consistency.sh
ai-dev-office/tests/integration/schema-validator-parity.sh
ai-dev-office/tests/integration/observability.sh
ai-dev-office/tests/integration/runner-failure-logged.sh
```

| Script | What it checks |
|--------|----------------|
| `contract-foundation.sh` | Portable contract files and generic doc surfaces |
| `dependency-policy.sh` | Blocked dispatch guard and unblock routing |
| `dependency-guard.sh` | `check-service-dependencies.sh` behavior |
| `auto-parallel.sh` | Parallel dev lanes in auto mode |
| `context-provider.sh` | SocratiCode injection and fallback |
| `operator-commands.sh` | `intake`, `verify`, `cleanup` |
| `status-command.sh` | `status` summary and next command |
| `runner-fallback.sh` | Runner auto-switch on quota/auth failures |
| `bootstrap-sync.sh` | Bootstrap/sync install boundaries |
| `profile-merge.sh` | `--profile` / `OFFICE_PROFILE` merge |
| `output-contract.sh` | Invalid agent output routes to `validation_failed` |
| `decision-reconcile.sh` | Driver applies `decision.yaml` to `status.yaml` (idempotent) |
| `driver-decision-e2e.sh` | End-to-end dispatch: enforce gate + decision reconcile + terminal-stop |
| `concurrent-status-writes.sh` | Per-task flock prevents lost updates under concurrent (parallel-lane) writes |
| `resilience-fail-loud.sh` | Malformed output routes to validation_failed (no crash); corrupt status.yaml is backed up, never flattened to a stub |
| `loop-guard-bounded.sh` | free-roam no longer resets the iteration budget; a free_roam_entries cap halts runaway escalation before dispatch |
| `validation-failed-bounded.sh` | validation_failed routes to free-roam, counts retries, refuses re-dispatch of the failing agent, and halts at the cap |
| `idempotency-and-reentry.sh` | Re-syncing the same output artifact is a no-op (no double-increment); pm/auto refuse to re-open a done/aborted task |
| `decision-path-integrity.sh` | Malformed decision.yaml is surfaced (not dropped); a decision without decided_at is skipped; a non-terminal decision re-aligns the dispatched agent |
| `state-machine-consistency.sh` | A failed upstream escalates the dependent (no forever-wedge); cleanup maps validation_failed/blocked and flags unmapped phases; reviewer scaffold/schema agree on the queue phase |
| `schema-validator-parity.sh` | The runtime validator (validate-yaml.rb) and the (non-runtime) schemas agree on the key enums — catches contract drift |
| `observability.sh` | Transitions carry an `at` timestamp; validation_failed keeps the specific error; the validator checks history; `status` shows recent reasons |
| `runner-failure-logged.sh` | A crashing runner records a runner_failed meta event (with exit code) and persists its transcript |

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
  runners/                  # codex, cursor-agent, cursor
  workflows/
  schemas/
  profiles/
  templates/
  scripts/
  docs/
  runs/<task-id>/           # Runtime task state (gitignored; not installed to targets)
```

Legacy v1 agent references live under `docs/legacy-v1/` for archive only. Active role prompts stay in `agents/`.

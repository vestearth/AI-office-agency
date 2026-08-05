# AI Dev Office Model Routing (Codex-first)

> **Scope (operator model):** this document governs the **automated runner lane** —
> how `run-agent.sh` selects a runner *inside* a formal run. It does **not** govern
> the interactive **conductor lane** above it, where a human commands Claude or
> Codex as conductor and they delegate to subagents (Cursor, Antigravity CLI). See the
> operator model in [AGENTS.md](AGENTS.md) and knowledge-base ADR-0003. The two
> lanes coexist: a conductor invokes this Codex-first pipeline when it runs the
> formal workflow.

Routing policy: **Codex-first**. Claude and Antigravity CLI may be used as `manual advisory lanes` for architecture reasoning or an extra review pass when needed.

## Routing Matrix

| Role | Default runtime | Goal |
|---|---|---|
| `pm` | Codex | Task slicing, acceptance criteria, risk register |
| `dev` | Codex, Cursor CLI Agent, or Cursor IDE | Implementation, focused tests, merge-ready output |
| `dev-2` | Codex, Cursor CLI Agent, or Cursor IDE | Cross-service implementation, migration safety |
| `reviewer` | Codex | Regression, compatibility, release risk review |
| `debugger` | Codex | RCA, minimal-risk fixes, production-aware mitigations |
| `devops` | Codex | CI/CD, deploy risk, runbook and infra changes |
| `free-roam` | Codex | Ambiguity resolution, stuck-pipeline arbitration |

## Trigger Rules (Codex-first)

- Require evidence from build/tests, scoped changes, and the existing YAML handoff contract.
- Escalate to `free-roam` when blockers repeat, scope is unclear, or risk is too high for a single pass.
- For high-risk work (multi-service, contract change, production incident), add **human** review or an extra Codex review round with stricter checklist—no separate model required unless evidence shows it's necessary.

## Runner Fallbacks

- Use Codex first for all automated phases.
- If Codex is unavailable, switch to Cursor CLI Agent, then Cursor IDE.
- Fallback runners do not replace `reviewer` / `debugger` gates.

## Secondary Manual Advisory Lanes

- Claude and Antigravity CLI may be used as `manual advisory lanes` for PM critique, reviewer second opinion, and selective dev/debugger cross-checks.
- They are not part of automated runner routing.
- They do not replace `reviewer` / `debugger` gates.
- Any role response remains draft until normalized into AI Dev Office artifacts and validated.

## Cost and Throughput Guardrails

- One focused pass per phase unless risk demands another.
- Avoid repeated calls for formatting-only edits.
- Keep prompts short: scope, acceptance criteria, artifact paths, and prior `blockers`.

## Minimal Workflow

1. `pm` (Codex): scope and acceptance criteria.
2. `dev` or `dev-2` (Codex, Cursor CLI Agent, or Cursor IDE): implement and test.
3. `reviewer` (Codex): release readiness and verdict.
4. `debugger` (Codex): only when review requests fixes or incidents need RCA.

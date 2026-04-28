# AI Dev Office Model Routing (Codex-only)

Current policy: **all AI Dev Office roles run on Codex** (or the Cursor agent you invoke with Codex). No Claude pass in the default flow.

## Routing Matrix

| Role | Default runtime | Goal |
|---|---|---|
| `pm` | Codex | Task slicing, acceptance criteria, risk register |
| `dev` | Codex or Cursor (Codex-backed) | Implementation, focused tests, merge-ready output |
| `dev-2` | Codex or Cursor (Codex-backed) | Cross-service implementation, migration safety |
| `reviewer` | Codex | Regression, compatibility, release risk review |
| `debugger` | Codex | RCA, minimal-risk fixes, production-aware mitigations |
| `devops` | Codex | CI/CD, deploy risk, runbook and infra changes |
| `free-roam` | Codex | Ambiguity resolution, stuck-pipeline arbitration |

## Trigger Rules (Codex-only)

- Same quality bar as before: evidence from build/tests, scoped changes, YAML handoff unchanged.
- Escalate to `free-roam` when blockers repeat, scope is unclear, or risk is too high for a single pass.
- For high-risk work (multi-service, contract change, production incident), add **human** review or an extra Codex review round with stricter checklist—no separate model required.

## Copilot

- Optional inline accelerator during `dev` / `dev-2` (autocomplete, boilerplate, test skeletons).
- Does not replace `reviewer` / `debugger` gates.

## Cost and Throughput Guardrails

- One focused pass per phase unless risk demands another.
- Avoid repeated calls for formatting-only edits.
- Keep prompts short: scope, acceptance criteria, artifact paths, and prior `blockers`.

## Minimal Workflow

1. `pm` (Codex): scope and acceptance criteria.
2. `dev` or `dev-2` (Codex/Cursor): implement and test.
3. `reviewer` (Codex): release readiness and verdict.
4. `debugger` (Codex): only when review requests fixes or incidents need RCA.

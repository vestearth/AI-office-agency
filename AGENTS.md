# AI Dev Office Framework Rules

This repository is the portable AI Dev Office framework. These rules apply to the framework itself and to any copy installed into a target project.

## Rule precedence

When this framework is installed into another repository, use this order:

1. User request or direct task instructions
2. The target project's own `AGENTS.md`
3. This framework `AGENTS.md`
4. Framework docs, configs, templates, and runner prompts

Target projects are expected to provide their own `AGENTS.md` for project-specific behavior. This framework file stays generic and does not replace the target project's source-of-truth rules.

## Portability rules

- Keep portable framework files free of machine-specific paths, secrets, and task history.
- Put local overrides in ignored files such as `office.config.local.yaml`, `profiles/*.local.yaml`, `.env`, `.env.*`, and `.socraticode.local.yaml`.
- Treat `office.config.example.yaml` as the portable starting point. It should use placeholders and profile-driven defaults rather than workspace-specific values.
- Use `templates/install-manifest.yaml` as the contract for what can be installed into a target project by default.
- Verify portable contract assumptions with `tests/integration/contract-foundation.sh` before changing framework docs or example config.
- Do not copy runtime artifacts, logs, generated handoff outputs, or old task history unless a workflow explicitly asks for them.

## Framework boundaries

- `README.md` describes the framework contract and usage.
- `SKILL.md` describes the portable skill entrypoint.
- `office.config.example.yaml` describes the generic configuration surface.
- `profiles/` contains optional project-specific overlays.
- `templates/` contains install and starter templates for target projects.
- `runners/`, `agents/`, `schemas/`, `scripts/`, and `workflows/` define the framework runtime.

## Evidence-first boundary

AI Dev Office is the workflow control plane: it coordinates PM / Dev / Reviewer /
Debugger lanes and records task state, YAML handoffs, decisions, logs, validator
results, and verification evidence. It is not the source of code truth by
itself.

Tool truth hierarchy:

1. Current repository files
2. Tests / CI / runtime logs
3. Explicit task requirements / product/API contract
4. SocratiCode findings
5. ai-dev-office run records
6. knowledge-base historical notes

When sources disagree, current repo files plus verified tests/logs beat indexed
summaries, run records, and historical notes.

## Working rules

- Prefer the repository files, tests, and runtime outputs over memory when answering framework-specific questions.
- Keep changes scoped to the requested framework layer and avoid dragging target-project policy into portable defaults.
- If a later task needs project-specific assumptions, move them into a profile or template rather than the core docs.

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

Verification commands are recorded, not described. Run builds, tests, and static
checks through `scripts/record-evidence.sh <TASK_ID> -- <command>`, which
captures the output, hashes it, and appends a record to
`runs/<task>/evidence.yaml`. Role outputs cite the returned ids in an optional
`evidence_refs` field. The canonical contract — id grammar, staleness rule, and
what the validator recomputes — is `docs/evidence-contract.md`.

Review depth follows deterministic path rules, not a judgement of how important
a change feels: `office.config.yaml` → `reviewer.risk_rules` maps changed paths
to `high | medium | low`, and the level decides whether a `build_check` `pass`
must be backed by evidence. Enforcement ships behind
`reviewer.evidence_policy.mode` (`warn_only` by default — the gap is recorded in
`meta.yaml`; `required` makes `approved` unreachable without evidence). See
`docs/reviewer-policy.md`.

## Operator model (conductor and subagent)

Operators and role enums are two different axes (see knowledge-base ADR-0002 —
roles define behavior, lanes define wiring; this adds the operator-orchestration
axis). Do not collapse them: a role is a contract some operator fulfils, not an
operator you call.

- **Role** — a workflow contract/phase. The role enum is the machine contract:
  `pm dev dev-2 reviewer debugger devops free-roam done`. Roles are the only
  values allowed in the **validator-enforced enum fields**: `current_agent`,
  `assignment.primary`, `next_action.agent`, `handoff.to` / `handoff.from`, and
  `events[].agent` (these are `expect_enum` in `validate-yaml.rb`).
- **Operator** — the runtime actor that performs work (e.g. Claude, Codex,
  Cursor, Antigravity). Operators are interchangeable and are **never** written into
  the enforced enum fields above. Operator provenance belongs in free-text
  (`reason` / `notes`). `history[].agent` is a **shape-validated provenance**
  field (`expect_string`, not an enum), so it may record either the role or the
  operator that performed a transition — do not treat it as an enum field.

Each task has exactly **one conductor** and zero or more subagents:

- **Conductor** — the single operator a human commands for the task. It owns the
  task end to end and fulfils role contracts per phase. Recommended default
  conductors: Claude and Codex.
- **Subagent** — an operator a conductor delegates scoped sub-work to. Delegation
  happens inside the conductor's interactive session, not through `run-agent.sh`,
  and adds no runner, hook, scheduler, or MCP. Recommended default subagents:
  Cursor (workspace-local edits) and Antigravity CLI (research / wide-context). A conductor
  may also delegate to a same-operator subagent.

**Solo is the default.** A conductor may complete a task alone. Delegation is an
optimization for a clear reason (parallelism, scope isolation, operator-specific
strength), and subagent output is verified before it is accepted. Over-delegation
is an anti-pattern.

### Lightweight-to-formal escalation

The conductor lane is for daily work (review, debug, implementation loop, small to
medium scoped changes). Convert to a formal AI Dev Office run immediately —
retroactively if needed — the moment a task touches any of:

- a contract (proto / gRPC / API / gateway / event schema / role enum)
- more than one repository
- a data or runtime migration
- production infra, deploy, or secrets
- a rollback that is not a single `git revert`

This is a checkable tripwire, not a matter of discretion. Editing the meta
framework repos themselves stays exempt from the per-task run requirement.

## Post-task knowledge capture

After a task produces durable knowledge (decision, lesson, flow, concept), capture
it. The portable default is suggest-only; an auto-write is allowed only when the
target repository's own `knowledge-base/AGENTS.md` explicitly names the product
scope, allowed targets, evidence gate, and human review mode.

- Any operator (Claude / Codex / Cursor / human): run the lane-neutral runner
  `scripts/knowledge-capture.rb <TASK_ID>` (brief + candidate sources + schema
  skeleton), apply the `knowledge-capture` skill's judgment, write
  `runs/<task-id>/knowledge-capture-output.yaml`, then validate with
  `scripts/knowledge-capture.rb --validate <TASK_ID>`.
- Claude may instead dispatch the `knowledge-capturer` subagent — gather, judgment,
  and write in one step (knowledge-base ADR-0006).
- Contract: `workflows/knowledge-capture.md` + `schemas/knowledge-capture-output.schema.json`.
  Output stays `requires_human_review: true`; a human applies it to the vault
  (knowledge-base ADR-0005).
- Vault-health review uses `workflows/knowledge-librarian.md` and
  `schemas/knowledge-librarian-output.schema.json`. It stays outside the role /
  phase machine and writes its local audit to `knowledge-reviews/`. Validate with
  `ruby scripts/validate-knowledge-librarian.rb <path>`.
- At the end of every non-trivial working session, the conductor dispatches
  `knowledge-librarian` once against the session-touched knowledge and source
  scope before sending the final closeout or handoff. This closeout trigger is
  independent of task `done` and must not mutate task state. Key the scope by
  parent thread plus coherent product workstream, not by turn, task label, or
  QA/design/implementation/configuration/publish stage. Before spawning, inspect
  active and completed subagents: reuse the same-scope librarian with
  `followup_task` when material evidence changes, skip when it does not, and
  spawn a new librarian only for a genuinely distinct workstream.
- For a **Codex** `knowledge-librarian` dispatch, explicitly set
  `model: gpt-5.6-terra` and `reasoning_effort: high`; never leave this
  quality-first Codex role on `auto`. Keep the Standard speed tier. Escalate
  only to `gpt-5.6-sol` at High when the explicit scope is cross-repository,
  includes an architecture decision or important contract, or contains
  materially conflicting evidence. Include the escalation reason in the audit
  scope or closeout; ordinary Codex audits remain on Terra High.
- For a **Cursor** `knowledge-librarian` dispatch (IDE or Agent Task), use
  Cursor Auto: omit an explicit model override (adapter `model: inherit`). Do
  not force Terra/Sol slugs on the Cursor lane.
- In an explicitly approved auto-write scope, `requires_human_review: true`
  means post-write review. The librarian records authorization and every applied
  change, but never commits, pushes, accepts ADRs, or promotes shared knowledge.

## Working rules

- Prefer the repository files, tests, and runtime outputs over memory when answering framework-specific questions.
- Keep changes scoped to the requested framework layer and avoid dragging target-project policy into portable defaults.
- If a later task needs project-specific assumptions, move them into a profile or template rather than the core docs.

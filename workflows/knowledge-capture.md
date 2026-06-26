# Knowledge Capture Workflow

This workflow produces a suggest-only knowledge capture output for `knowledge-base/`.

It does not write to `knowledge-base/`, commit across repositories, or mutate
task runtime state. AI Dev Office run state remains in
`runs/<task-id>/status.yaml`; role behavior remains in `agents/*.md`. Current
repo files, tests, CI, logs, runtime config, current contracts, and actual
runtime behavior remain the final source of truth.

## When To Run

Use after a task creates durable knowledge worth remembering, especially after:

- `task_done`
- `reviewer_approved`
- `incident_closed`
- `architecture_decision`

The knowledge config may list these triggers under `knowledge.capture_on`, but capture remains suggest-only unless a human explicitly applies the patch.

## Inputs

- `runs/<task-id>/status.yaml`
- Relevant `runs/<task-id>/*-output.yaml`
- Relevant task evidence such as tests, CI output, logs, decisions, or verification notes
- `knowledge-base/AGENTS.md`
- `Knowledge Base/How To Use This Vault.md`
- `Knowledge Base/Source Link Convention.md`

## Output

Write or propose a YAML document matching `schemas/knowledge-capture-output.schema.json`.

Recommended path:

```text
runs/<task-id>/knowledge-capture-output.yaml
```

The output must include:

- `task_id`
- `capture_type`
- `target_repo`
- `target_note`
- `summary`
- `sources`
- `recommended_action`
- `requires_human_review`
- `note_patch`

## Rules

1. Search `knowledge-base/` before proposing a new note.
2. Prefer updating an existing note when the concept already exists.
3. Choose a target path using `knowledge-base/AGENTS.md` write targets.
4. Include `Source:` or `Sources:` in the proposed note for durable claims.
5. Keep `requires_human_review: true` unless a future workflow explicitly changes this contract.
6. Do not auto-write, auto-commit, or auto-push changes to `knowledge-base/`.
7. Do not treat the vault as stronger evidence than current repo files, tests, CI, logs, or production signals.

## Suggested Flow

1. Read the task status and relevant role outputs.
2. Decide whether the task produced durable knowledge.
3. Search existing knowledge-base notes.
4. Choose `recommended_action`: `create_note`, `update_note`, `add_to_inbox`, or `skip`.
5. Draft `note_patch`.
6. Validate the output against `schemas/knowledge-capture-output.schema.json` when tooling is available.
7. Hand the suggestion to a human for review.

## Tooling

A portable, lane-neutral runner does the deterministic parts of this flow for any
operator (Claude / Codex / Cursor / human):

```text
ruby scripts/knowledge-capture.rb <TASK_ID>            # brief + candidate sources + schema skeleton
ruby scripts/knowledge-capture.rb <TASK_ID> --skeleton # skeleton YAML only
ruby scripts/knowledge-capture.rb --validate <TASK_ID|path>   # validate an output (delegates to validate-yaml.rb)
```

It gathers `status.yaml` + role outputs + `decision.yaml`, pre-extracts candidate
sources as repo-relative paths, and emits a schema-shaped skeleton. It does **not**
make the capture judgment, call any model/CLI, write to `knowledge-base/`, or commit
— the operator applies the `knowledge-capture` skill to fill the skeleton, writes
`runs/<task-id>/knowledge-capture-output.yaml`, then validates it.

(Claude operators can instead dispatch the `knowledge-capturer` subagent, which
performs the gather + judgment + write in one step under the same contract.)

## Human Review

The human reviewer decides whether to apply the patch, edit it, move it to `Review Queue`, or skip capture.

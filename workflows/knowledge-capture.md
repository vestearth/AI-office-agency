# Knowledge Capture Workflow

This workflow produces a suggest-only knowledge capture output for `knowledge-base/`.

It does not write to `knowledge-base/`, commit across repositories, or mutate task runtime state. The runtime source of truth remains `runs/<task-id>/status.yaml`; role behavior remains in `agents/*.md`.

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

## Human Review

The human reviewer decides whether to apply the patch, edit it, move it to `Review Queue`, or skip capture.

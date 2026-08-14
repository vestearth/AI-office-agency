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

It may also carry an optional `provenance` block naming the task, run and
evidence the claim rests on. See [Provenance](#provenance) below.

## Rules

1. Search `knowledge-base/` before proposing a new note.
2. Prefer updating an existing note when the concept already exists.
3. Choose a target path using `knowledge-base/AGENTS.md` write targets.
4. Include `Source:` or `Sources:` in the proposed note for durable claims.
5. Keep `requires_human_review: true` unless a future workflow explicitly changes this contract.
6. Do not auto-write, auto-commit, or auto-push changes to `knowledge-base/`.
7. Do not treat the vault as stronger evidence than current repo files, tests, CI, logs, or production signals.
8. Record provenance when the task produced real executed evidence, and never
   declare `freshness: current` unless someone actually re-checked the claim.

## Provenance

`provenance` is optional. An output without it validates exactly as before and
reads as `unknown` — no provenance is not an accusation.

```yaml
provenance:
  freshness: unknown   # current / unknown / maybe_stale / stale / invalid / historical
  verified_at: "2026-08-15"
  task_id: TASK-EAR-259
  run_id: run-20260815T101500Z-TASK-EAR-259-dev-k3f9a2
  evidence_refs: [ev-001]
  repo_origin: SparqLab/missions
  repo_sha: 8f295531c0a7f1e0d4b2a9c8e5f30b71d6a4c2e9
  confidence: high
```

The field names and the freshness vocabulary are the canonical workspace ones
(`knowledge-base/Knowledge Base/Provenance And Freshness.md`); the identifiers
come verbatim from `docs/evidence-contract.md` and `docs/run-records.md`. The
block is written so it can be pasted into the promoted note's YAML frontmatter
unchanged — `scripts/knowledge-capture.rb` already seeds `note_patch` with it.

Rules that matter when filling it in:

- `verified_at` is the day the claim was **actually re-checked against reality**,
  not the day the note was written or the task closed. If nobody checked, omit it.
- Only an actual check earns `current`. Writing the note is not a check.
- `evidence_refs` are `ev-NNN` ids from **this** task's `evidence.yaml`; they are
  task-scoped, so `task_id` must travel with them.
- `confidence` needs `verified_at` plus `run_id` or `evidence_refs` behind it.
- `repo_sha` is provenance, not liveness. Nothing compares it against HEAD.

If any cited evidence has been marked in `runs/<task-id>/evidence-freshness.yaml`,
the capture must declare `maybe_stale` (or `stale` / `invalid`) — validation
refuses `current`. Still write the capture: degraded knowledge stays discoverable
via `scripts/knowledge-freshness.rb`, and is never deleted or hidden.

Full contract: [`docs/knowledge-provenance.md`](../docs/knowledge-provenance.md).

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
ruby scripts/knowledge-freshness.rb [TASK_ID] [--degraded]    # declared vs effective freshness
ruby scripts/mark-evidence-stale.rb <TASK_ID> <ev-id> --reason "..."  # degrade one evidence record
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

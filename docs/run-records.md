# Run Identity And Agent Observability

Every agent execution gets one **run record**. The run id is the stable anchor
that everything else in the office hangs off — meta events, and (once the
execution-evidence contract lands) evidence records too.

Shape: [run-record.schema.yaml](../schemas/run-record.schema.yaml).
Writer: [`scripts/record-run.rb`](../scripts/record-run.rb).
Runtime rules: `validate_run_record` in `validate-yaml.rb` (the schema is a
documentation mirror — S7).

## Run id grammar

```
<run_id> := "run-" <ts> "-" <task_id> "-" <role> "-" <nonce>
<ts>     := YYYYMMDDTHHMMSSZ            # UTC, basic ISO-8601
<task_id>:= TASK-NNN | TASK-<NS>-NNN
<role>   := pm | dev | dev-2 | reviewer | debugger | devops | free-roam
<nonce>  := 6 chars of [0-9a-z]
```

Example: `run-20260815T101500Z-TASK-EAR-259-dev-k3f9a2`

Downstream repos consume this grammar verbatim, so the ordering of the parts is
part of the contract:

- **Time first** so a plain lexicographic sort of run ids (or of the filenames)
  is chronological, with no date parsing.
- **Task and role inline** so a run id is self-identifying out of context — a
  log line or an evidence record carrying only the id still says which task and
  which role it belongs to. The validator enforces that the embedded task id and
  role match the record's own fields, so the two can never drift.
- **Nonce last** to separate retries of the same role on the same task inside
  the same second. It is not the collision defence on its own: id allocation
  happens under the task's `.lock`, and the writer regenerates rather than
  overwrite an id that already has a file. Collisions are therefore impossible
  by construction, not merely improbable.

## Storage

```
runs/<task-id>/run-records/<run_id>.yaml
```

One file per run. Why not the alternatives:

- **Not `status.yaml`** — a run is append-only history, not mutable task state.
  `status.yaml` is the single source of truth for *where the task is now*.
- **Not a `runs:` list inside `meta.yaml`** — a record is written three times
  (start, finish, validation outcome). Folding it into `meta.yaml` would rewrite
  the entire event log on each of those writes, widening exactly the
  read-modify-write window that `tests/integration/concurrent-status-writes.sh`
  exists to pin. One file per run means two parallel lanes (dev / dev-2) never
  touch the same file at all.
- **Directory named `run-records`, not `runs`** — the task dir already lives
  under `runs/`, and the dashboard's artifact lister reads the task dir flat; a
  nested `runs/` would read as a mysterious artifact entry.

`meta.yaml` stays the event log and remains coherent: each event now carries a
structured `run_id` field attributing it to the run that emitted it. Events
logged outside a dispatch, and every event written before run identity existed,
have no `run_id` — consumers must tolerate its absence.

## Fields the harness cannot observe

Identity fields are **required but nullable**. The harness records what it can
actually observe and writes `null` for the rest; it never guesses.

| Field | Source |
|---|---|
| `client` | the runner that actually executed, after any fallback switch (`runners/<id>.yaml` → `runner.id`) |
| `harness_version` | `office.config.yaml` → `office.version` |
| `instruction_sha` | `sha256:<hex>` of the assembled prompt actually sent to the runner |
| `repo_sha` | `git rev-parse HEAD` of the repo the run operates on; `null` outside a worktree |
| `model_requested` | `AI_DEV_OFFICE_MODEL`; `null` normally — this harness does not pin a model on the CLIs |
| `model_observed` | `AI_DEV_OFFICE_MODEL_OBSERVED`; `null` unless a runner reports it |
| `skill_version` | `AI_DEV_OFFICE_SKILL_VERSION`; `null` when unset |
| `mcp_profile` | `AI_DEV_OFFICE_MCP_PROFILE`; `null` when unset |

## `usage` is optional, and its absence is normal

The Codex and Cursor CLIs do not expose token accounting, so the `usage:` block
is **absent** on essentially every run today. That is not a degraded run — it is
the expected shape. Nothing in the harness, the validator, or the read path
requires `usage`, and a run with no telemetry validates and completes exactly
like one with it.

When a runner does report telemetry, the writer accepts
`usage.input_tokens`, `usage.output_tokens`, `usage.cache_read`,
`usage.cache_write`, `usage.tool_calls`, `usage.validation_rounds` — each a
non-negative integer. Fields the runner did not report stay out of the block
entirely rather than being written as zero, so a missing metric is never
mistaken for a measured zero.

Observability is also non-fatal end to end: `run-agent.sh` swallows any failure
of the record writer. A lost record is a lost metric, never a lost dispatch.

## Read path for reporting

Run records are structured data. Every question below is answered by loading
`runs/*/run-records/*.yaml` and grouping on contracted enum fields — **never**
by parsing log text, summaries, or `meta.yaml` `details` strings.

| Question | How |
|---|---|
| Success rate by role / client / model | group records by `role`, `client`, `model_observed ?? model_requested`; success = `outcome.status == "completed"` |
| Validation failure frequency | share of records with `outcome.validation == "failed"` |
| Revision / retry frequency | count records per `(task_id, role)`; more than one means the role was re-dispatched |
| Reviewer catches after dev completion | for each task, take the `reviewer` records whose `started_at` is later than a completed `dev`/`dev-2` record, and join to `reviewer-output.yaml` → `review_verdict` (see [run-summary-read-model.md](run-summary-read-model.md)) |
| Repeated failure patterns | group `outcome.status == "failed"` records by `(role, client)` and by `instruction_sha` — an identical `instruction_sha` failing repeatedly means the same prompt keeps failing, not a flaky run |
| Which events belong to a run | filter `meta.yaml` `events[]` on `run_id` |

Sorting by `run_id` is sorting by start time, so a per-task timeline needs no
timestamp parsing.

## Deferred: evidence wiring

The execution-evidence contract is a separate slice. Once it merges, evidence
records will carry `run_id` as their foreign key into this store, joining "what
the run was" (here) to "what the run proved" (there). Nothing in this document
depends on that slice landing.

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
structured `run_id` field attributing it to the run that emitted it.

`run_id` is absent — and consumers must tolerate that — on:

- every event written before run identity existed;
- events logged outside a dispatch (e.g. a status-only invocation);
- **`context_provider`**, which is emitted while the prompt is still being
  assembled. The id cannot be allocated any earlier without breaking
  `instruction_sha`: that field hashes the prompt actually sent, and the context
  section is part of that prompt. Attribution of this one pre-assembly event is
  deliberately traded for an honest hash. `prompt_assembly` and everything after
  it are attributed.

## Fields the harness cannot observe

Identity fields are **required but nullable**. The harness records what it can
actually observe and writes `null` for the rest; it never guesses.

| Field | Source |
|---|---|
| `client` | the runner that actually executed, after any fallback switch (`runners/<id>.yaml` → `runner.id`) |
| `harness_version` | `office.config.yaml` → `office.version` |
| `instruction_sha` | `sha256:<hex>` of the assembled prompt actually sent to the runner |
| `repo_sha` | `git rev-parse HEAD` of the repo the run operates on; `null` outside a worktree |
| `model_requested` | `AI_DEV_OFFICE_MODEL` |
| `model_observed` | `AI_DEV_OFFICE_MODEL_OBSERVED` |
| `skill_version` | `AI_DEV_OFFICE_SKILL_VERSION` |
| `mcp_profile` | `AI_DEV_OFFICE_MCP_PROFILE` |

### What is populated today, and what is not

Be blunt about it: the last four fields have **no producer in this harness**.
Nothing sets `AI_DEV_OFFICE_MODEL`, `AI_DEV_OFFICE_MODEL_OBSERVED`,
`AI_DEV_OFFICE_SKILL_VERSION`, or `AI_DEV_OFFICE_MCP_PROFILE`, and the Codex and
Cursor CLIs are not invoked with a pinned model and do not report the one they
used. So `model_requested`, `model_observed`, `skill_version` and `mcp_profile`
are **structurally always null** right now.

The consequence is concrete: **"success rate by model" and "success rate by
skill version" are not answerable today.** The contract has the fields and the
read path knows how to group on them, but the data is not there. Only the
by-`role` and by-`client` cuts are live.

This is correct behaviour under the "record, never guess" rule — a fabricated
model string would be worse than a null — but it is a gap, not a feature. It
closes when a producer sets those env vars (an operator pinning a model, or a
runner that reports one), with no change to this contract.

Populated on every run today: `run_id`, `task_id`, `role`, `client`,
`harness_version`, `instruction_sha`, `repo_sha`, `started_at`, `completed_at`,
`outcome.*`.

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
| Revision / retry frequency | count records per `(task_id, role)`; more than one means the role was re-dispatched (see the caveat below) |
| Reviewer catches after dev completion | for each task, take the `reviewer` records whose `started_at` is later than a completed `dev`/`dev-2` record, and join to `reviewer-output.yaml` → `review_verdict` (see [run-summary-read-model.md](run-summary-read-model.md)) |
| Repeated failure patterns | group `outcome.status == "failed"` records by `(role, client)` and by `instruction_sha` — an identical `instruction_sha` failing repeatedly means the same prompt keeps failing, not a flaky run |
| Which events belong to a run | filter `meta.yaml` `events[]` on `run_id` |

Sorting by `run_id` is sorting by start time, so a per-task timeline needs no
timestamp parsing.

### Caveat: one record per dispatch, not per runner attempt

A dispatch is one record even when the harness retried internally. A run that
burned three codex attempts and then one cursor-agent attempt produces a
**single** record — `started_at`/`completed_at` bracket the whole dispatch, and
`client` names the runner that ran last. So the retry-frequency recipe counts
**operator re-dispatches**, not runner attempts. Per-attempt detail stays in
`meta.yaml` (`runner_retry` / `runner_switch` events), joinable by `run_id`.

## OPEN acceptance criterion: evidence traceability

The issue's acceptance criterion **"evidence can be traced to a `run_id`" is
still OPEN**, and this slice does not close it. `evidence.schema.yaml` and
`scripts/record-evidence.sh` from the evidence-contract slice carry no `run_id`
field today, so an evidence record cannot currently be joined to the run that
produced it.

The follow-up, once both slices are merged: add `run_id` to the evidence record
as its foreign key into this store, joining "what the run was" (here) to "what
the run proved" (there). Run identity is the stable anchor and needs no change
for that — the work is entirely on the evidence side.

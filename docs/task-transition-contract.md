# The minimum stable task/transition contract

Companion to [`docs/orchestration-boundary.md`](orchestration-boundary.md).
Describes what already exists as the contract between a workflow operation
and its inputs/outputs today — nothing here is a new field or a proposal;
every field named below is cited against the schema and/or the validator
rule that already enforces it.

## What `status.yaml` must contain for "what's next" to be determinable

Required by `schemas/status.schema.yaml` (`required:`, lines 12-16):
`task_id`, `phase`, `iteration`, `current_agent`.

- `task_id` — pattern `^TASK(?:-[A-Z][A-Z0-9]*)?-[0-9]+$` (schema line 20;
  same pattern as `validate-yaml.rb`'s `TASK_ID_PATTERN`, line 21).
- `phase` — enum of 15 values (schema lines 21-38), identical to
  `validate-yaml.rb`'s `PHASES` constant (lines 12-16) — the two are pinned
  together by `tests/integration/schema-validator-parity.sh` per the
  schema file's own header comment (line 3).
- `iteration` — integer ≥ 0 (schema lines 57-59). Drives the loop guard
  (`office.config.yaml`'s `loop_guard.max_iterations`).
- `current_agent` — nullable, else one of the eight role/terminal values
  (schema lines 72-84). **This is the practical answer to "what's next"** —
  there is no separate `next_action` field on `status.yaml` itself (see the
  next paragraph for where `next_action` actually lives).

Not required but load-bearing for correctness once present:

- `state` — must equal `phase` when both are present
  (`validate-yaml.rb`'s cross-field check, "status.yaml.state must match
  status.yaml.phase").
- `blocked_on` / `waiting_for` — a `blocked` phase/state requires at least
  one non-empty (`validate-yaml.rb`'s blocked-coherence check).
- `history` — array of `{phase, agent, reason}` (all three required,
  schema lines 161-165), `at` optional but present on every entry written
  since issue N1 (schema line 184). This is what `./run-agent.sh status`
  reads to print "Recent:" transitions, and what
  `docs/run-agent-classification.md`'s workflow functions append to on every
  transition.
- `last_synced_output` — `{file, digest, next}` fingerprint of the last
  output artifact applied (schema lines 68-71). Not required for a *new*
  task, but required for `sync_status_from_output`'s idempotency check to
  work correctly on a re-dispatch (see below).

**Clarification on "next_action":** the issue's own resilience framing asks
whether `next_action` is present on `status.yaml`. It is not — `next_action`
is a field on the *role output* file (`<role>-output.yaml`, next section),
not on `status.yaml`. What `status.yaml` carries instead is the *result* of
having already applied a role's `next_action`: `current_agent` and `phase`.
An operator inspecting only `status.yaml` (no output files, no runner) can
always answer "who runs next," which is what resilience point (2) requires;
they cannot recover *why* without also reading `history[].reason` or the
most recent `<role>-output.yaml`.

## What a role's `<role>-output.yaml` must produce for the workflow to transition

Base contract, `schemas/agent-output.schema.yaml`, `required:` (lines 12-16):
`summary`, `artifacts`, `next_action`, `blockers`.

- `next_action.agent` — required, one of the eight role/terminal values
  (schema lines 63-77). This is the field `sync_status_from_output` reads
  (`output["next_action"]["agent"]`) to decide the new `current_agent` and,
  via the hardcoded `actor_agent`/`next_agent` table, the new `phase`.
- `next_action.reason` — required (schema line 78-79); becomes the
  `history` entry's `reason` if present, else the sync falls back to the
  first line of `summary`, else a generic "Transitioned by `<agent>`
  output." string (never a hard failure on a missing reason).
- `artifacts[].path` — required per artifact (schema line 25); consumed by
  `show_verify_plan` (the `verify` operator command) to build a
  verification command list, and by the reviewer's evidence-policy gate.
- `blockers` — required, array (schema line 80-83); no downstream logic
  currently branches on its contents beyond presence.

Reviewer-specific extension (`schemas/reviewer-output.schema.yaml`,
`required:` lines 14-16): `review_verdict`, `build_check`. `review_verdict`
is the fallback `next_agent` source when `next_action.agent` is absent — see
`sync_status_from_output`'s reviewer-specific fallback
(`approved`→`done`, `changes_requested`→`debugger`, `escalate`→`free-roam`,
`infra_failure`→`devops`).

## What "record/import the resulting output" concretely means today for a manually-run role {#recordimport-a-manually-produced-output}

Traced directly through `sync_status_from_output` and
`scripts/enforce-output-contract.rb` (not assumed):

1. `enforce-output-contract.rb <TASK_ID> <AGENT>` takes only a task id and
   role name. It looks up the role's `output_file` in `agents/manifest.yaml`,
   skips entirely if the manifest has no entry or the validation policy
   isn't `strict`, and otherwise shells out to `ruby validate-yaml.rb
   <output_path>`. **No run identity, no runner name, no
   `AI_DEV_OFFICE_RUN_ID` is read anywhere in this script.** A hand-written
   `<role>-output.yaml` that happens to satisfy the schema passes this gate
   exactly like a machine-produced one.
2. `sync_status_from_output`'s Ruby heredoc ARGV is
   `task_id, actor_agent, status_path, output_path, today,
   reviewer_queue_phase` — again, no run identity. It: takes the per-task
   file lock; fences on `TaskOwnership.fence!` (see coupling point #2
   below); loads `status.yaml`, hashes the output file
   (`Digest::SHA256.hexdigest`), and compares that digest plus the
   basename against `status["last_synced_output"]` — if they match, the
   sync is a no-op (idempotent re-dispatch protection, note M2 in the code).
   Otherwise it reads `next_action.agent`/`reason` (or the reviewer
   fallback), computes `new_phase` from the hardcoded table, updates
   `iteration`/`free_roam_entries` as appropriate, and atomically rewrites
   `status.yaml` with the new `phase`/`current_agent`/`handoff`/`history`
   entry.
3. Because neither step reads anything runner-specific, a manually-produced
   output file transitions the task **identically** to a runner-produced
   one, provided it passes schema validation.

The one piece the driver adds around this that a fully manual path would
otherwise miss is the "was this file actually just written" check
(`INTERACTIVE_RUNNER`/`OUTPUT_MTIME_EPOCH`, main dispatch body ~lines
2830-2876): when the dispatched runner is `cursor` (which performs no AI
invocation — it only writes `.cursor-prompt.md`, see
`run_runner_once`'s `cursor` case, ~lines 1289-1298), the driver compares
the output file's mtime against the moment the run started. If the file is
older, it skips the sync ("Output file exists but was not updated in this
interactive run... re-run this command to sync") rather than replaying a
stale artifact. **This is the existing, designed manual-import path**: run
`./run-agent.sh <TASK_ID> <ROLE> cursor` once to get the prompt saved, do
the work in any tool (an IDE, a different AI, by hand), save
`<role>-output.yaml`, then re-run the identical command — the driver now
sees a fresh mtime and proceeds through the same
`enforce-output-contract.rb` → `sync_status_from_output` →
`validate-yaml.rb` path described above.

## Explicitly not-yet-runtime-independent coupling points {#coupling-points-not-yet-runtime-independent}

Named precisely, per the brief, rather than glossed over:

1. **The transition functions are not standalone.** `sync_status_from_output`,
   `force_status_route`, and `reconcile_blocked_status` are Ruby heredocs
   defined *inside* `run-agent.sh`, not files under `scripts/`. Unlike
   `scripts/reconcile-decision.rb` or `scripts/execution-budget.rb` (which
   already are standalone, runtime-independent scripts this document could
   cite by path), there is today no way to invoke the core "apply this
   output and transition the task" logic except by going through
   `run-agent.sh`'s dispatch body — which also runs preflight, ownership
   acquisition, task-input-integrity snapshotting, and runner selection
   around it, even for a manual flow. This is the single biggest concrete
   blocker to a non-`run-agent.sh` driver reusing the same transition logic
   verbatim, and it is exactly what Phase 2's extraction would need to
   resolve (see the recommendation in `docs/orchestration-boundary.md` §6).
2. **Ownership leases are keyed to `AI_DEV_OFFICE_RUN_ID`, which only
   `run-agent.sh` mints.** `record_run_start` (via `scripts/record-run.rb`)
   is the sole writer of this env var, and `ownership_acquire` explicitly
   no-ops when it is unset (`[[ -n "${AI_DEV_OFFICE_RUN_ID:-}" ]] || return
   0`) — so the fence **fails open**, not closed, for any execution path
   that doesn't set it. A future external orchestrator wanting mutual
   exclusion against a `run-agent.sh`-driven run would need to mint a
   compatible run id and set the same env var, or accept that its writes
   are unfenced. Not fatal today (nothing currently requires the id to
   exist before a transition can happen — sync and force-route both proceed
   regardless), but it is real: ownership *protection* is currently only
   active for `run-agent.sh`-originated dispatches.
3. **Task-input-integrity protection is 100% coupled to going through
   `run-agent.sh`.** `task_input_integrity_snapshot`/`_verify` wrap
   specifically around the runner subprocess call inside `run-agent.sh`'s
   own dispatch body (~lines 2818-2864). A role run entirely outside this
   script — e.g. an operator pasting a prompt into a chat UI by hand with no
   `run-agent.sh` invocation at all, not even the `cursor` no-op runner —
   gets none of this protection. It only applies to the "dispatch through
   `run-agent.sh`" path, including its manual-`cursor`-runner variant
   described above (which *does* invoke `run-agent.sh` twice, so it *is*
   covered).
4. **`AI_DEV_OFFICE_RUN_ID` also tags `meta.yaml` events** (`log_meta_event`,
   `event["run_id"] = run_id unless run_id.empty?`) — purely observability,
   optional, and already designed to degrade gracefully (absent outside a
   dispatch). Not a hard coupling, listed here only so it isn't confused
   with #2/#3 above, which do gate real behavior.
5. **Multi-user git sync (`office-git-sync.sh` pull/push) only runs from
   inside `run-agent.sh`'s dispatch body.** A role executed entirely outside
   `run-agent.sh` bypasses the pull-before-dispatch / push-after-dispatch
   hooks; an operator on a team with `git_sync.enabled: true` would need to
   run `bash scripts/office-git-sync.sh pull`/`push` manually to stay in
   sync. Minor coupling, worth naming since Phase 2's "manual role, no
   `run-agent.sh` at all" scenario would silently drop this today.

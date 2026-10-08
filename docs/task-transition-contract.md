# The minimum stable task/transition contract

Companion to [`docs/orchestration-boundary.md`](orchestration-boundary.md).
Describes the implemented contract between a workflow operation and its
inputs/outputs. The fields below are backed by schemas or validator rules.

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
  there is no contract-required `next_action` field on `status.yaml` (see the
  clarification below for where `next_action` actually lives).

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
- `completion_gates` (issue #28, optional) — declared gates that must all be
  `pass` or `na` before any writer may set `done`. See
  [`docs/completion-gates.md`](completion-gates.md). The guard is checked by
  `sync-status-from-output.rb`, `reconcile-decision.rb`,
  `force-status-route.rb` and `decide-next-step.rb`, and re-checked by
  `validate-yaml.rb` on stored state. A gate may wait on other gates
  (`after`, Phase 2B): it cannot pass until they are resolved. See
  [`docs/completion-gates.md`](completion-gates.md#gate-ordering-phase-2b).
  A gate may also require a record of what actually ran (`requires_record`,
  `ran`, Phase 2C); a required record missing on a stored pass leaves the gate
  unresolved. See [`docs/completion-gates.md`](completion-gates.md#gate-run-records-phase-2c).
- `branches` (issue #28 Phase 1C, optional) — independent portions of an
  assigned task. A branch may be `ready`, `blocked`, `done`, or `na`; a blocked
  branch does not block a ready sibling. All declared branches must be `done`
  or `na` before any writer may mark the task `done`. The governed writer is
  `scripts/update-task-branch.rb`; the validator checks shape and stored
  terminal state. See [`partial-branches.md`](partial-branches.md).
- `authorization.yaml` (issue #28 Phase 1B.1, optional) — an append-only ledger of grants/revokes per task. A gate that declares `requires_authorization` is checked against it by the guard (`can_transition_to_done_in`), as of the gate's own `(updated_at, authorization_through)`. See [`authorization-ledger.md`](authorization-ledger.md).
- Dispatch-time authorization check (issue #28 Phase 1B.2) — not a status field: immediately before `record_run_start`, `run-agent.sh` checks a configured role's dispatch against the pending bound gates and the ledger, and appends one `authorization_dispatch_check` event (no `run_id`) to `meta.yaml` per applicable admission attempt. It never writes `status.yaml`. `warn_only` (shipped) proceeds; `required` refuses before any run record or lease exists. See [`authorization-ledger.md`](authorization-ledger.md#dispatch-time-authorization-check-phase-1b2).
- Failure classification (issue #28 Phase 1D) — `scripts/classify-task-failure.rb` records a source-backed `failure_classified` event in `meta.yaml` and routes recovery through existing task phases. The event carries a machine-readable class, source reference, and recovery action; the status transition is written under the same task lock. See [`failure-recovery.md`](failure-recovery.md).
- `revisions` (issue #28 Phase 2A, optional) — append-only record of plan/scope changes, written only by `scripts/revise-task-plan.rb`. Each entry declares the gates/branches the change added (`effects`, created in the same write) or records `no_new_gates` with a reason. It adds no `done` rule; the gates and branches it declared are enforced by the existing guards. See [`plan-revisions.md`](plan-revisions.md).

**Clarification on "next_action":** `next_action` is required on the *role
output* file (`<role>-output.yaml`), where it drives the transition. Real
`status.yaml` files also carry a `next_action` (plus `assigned_to` and
`assignment.workstream`) that the driver does not read and the validator does
not check; `schemas/status.schema.yaml` does not list them. Treat them as
human-facing notes, not contract fields.

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
2. `scripts/sync-status-from-output.rb`'s ARGV is
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

1. **The transition logic is standalone, but only reachable through
   `run-agent.sh`'s dispatch body for preflight/ownership/runner concerns.**
   The core "apply this output and transition the task" paths were extracted
   from `run-agent.sh` heredocs into `scripts/sync-status-from-output.rb`,
   `scripts/force-status-route.rb`, `scripts/reconcile-blocked-status.rb`,
   `scripts/reconcile-decision.rb` and `scripts/decide-next-step.rb`
   (issue #23 Phase 2). A non-`run-agent.sh` driver can call them directly;
   what it does not get is the preflight, ownership acquisition,
   task-input-integrity snapshotting and runner selection that
   `run-agent.sh` wraps around them.
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

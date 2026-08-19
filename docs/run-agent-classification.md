# `run-agent.sh` workflow-vs-runtime classification

Companion to [`docs/orchestration-boundary.md`](orchestration-boundary.md).
Produced by reading the whole of `run-agent.sh` (2933 lines, as of this
branch's base commit `c2aa3266`) top to bottom. Line numbers are
approximate — the goal is "find it fast," not a byte-exact index that a
future one-line diff would invalidate.

Three buckets, matching the issue's own definitions:

- **Workflow** — task state, phase transitions, validation, routing
  decisions, escalation policy. Belongs to "WHAT NEXT."
- **Runtime/execution** — actually invoking a process, choosing which binary
  runs, retry/fallback between runner binaries. Belongs to "WHO EXECUTES."
- **Boundary/glue** — currently couples the two but conceptually shouldn't
  have to. Either the runner's stdout/exit code is inspected to decide a
  workflow outcome, or workflow state is read to decide a runtime choice.

## Workflow

| Function / region | ~Lines | Why |
|---|---|---|
| `show_office_status` (the `status` command's Ruby heredoc) | 98-210 | Pure reader of `status.yaml`/`history`; computes the human-facing "Next:" command. No runner involved. |
| `show_intake_preview` | 217-365 | Task-id allocation, prefix registry enforcement, heuristic task classification (bugfix/devops/refactor/feature) — all decided from `status.yaml`/task-directory contents and `office.team.yaml`, never from a runner. |
| `show_verify_plan` | 367-438 | Decides *which verification commands apply* from artifact paths recorded in role outputs. The commands it prints (`go test`, `make proto`) are runtime-shaped strings, but the decision logic itself is workflow (task-scope-driven), and nothing here executes a runner. |
| `show_cleanup_report` | 440-534 | Cross-task consistency audit (`route_mismatch`, `blocked_dependency_done`) purely over `status.yaml` files. |
| `scaffold_output_template` / `write_scaffold_output` | 611-725 | Produces a starter `<role>-output.yaml` conforming to the schema. Workflow artifact generation, not execution. |
| `previous_agents_for` | 1065-1089 | Encodes the role graph (which prior role's output is relevant to which next role) — a workflow/routing table. |
| `find_latest_output_for_agents` | 1091-1125 | Walks `status.yaml.history` to find the most relevant prior output file. State-history logic. |
| `effective_iteration` / `effective_free_roam_entries` | 1133-1162 | Read the loop-guard counters straight from `status.yaml`. |
| `resolve_loop_limit` / `resolve_free_roam_loop_limit` / `config_value` / `config_list_values` / `config_bool` / `config_list_contains` | 1164-1226, 1388-1392 | Resolve workflow *policy* knobs (loop limits, dependency-policy switches) from `office.config.yaml`. Generic config plumbing, but every call site in this file uses it to answer a workflow question, never a "which binary" question. |
| `reconcile_blocked_status` | 1714-1855 | Named explicitly in the issue as workflow. Reads a blocked task's `blocked_on` deps, escalates on a failed upstream, unblocks and routes via `assignment.primary` otherwise. Pure state-machine logic; the only I/O is reading other tasks' `status.yaml`. |
| `sync_status_from_output` | 1857-2073 | Named explicitly in the issue as workflow. The core transition function: reads a role's `<role>-output.yaml`, computes the new `phase`/`current_agent` from a hardcoded `actor_agent` → `next_agent` → `new_phase` table, updates `iteration`/`free_roam_entries`, appends `history`. Takes no runner-identity argument at all (see `docs/task-transition-contract.md`). |
| `next_agent_from_output` | 2075-2107 | Pure reader: extracts `next_action.agent` (or the reviewer `review_verdict` fallback) from an output file. Used by the `auto` loop to decide whether to keep going — decision logic, not execution. |
| `parallel_plan_agents` | 2109-2198 | Validates a PM's `assignment.parallel: true` plan (owned-file conflicts, `parallel_safe`, distinct dev/dev-2 lanes) — a business rule over `pm-output.yaml`, independent of how the parallel lanes are later executed. |
| `mark_parallel_dev_complete` | 2259-2261 | Thin wrapper that calls `force_status_route`; the decision ("parallel lanes are done, route to reviewer") is workflow even though it's triggered from inside the runtime-heavy `auto` loop. |
| `force_status_route` | 2263-2334 | Named explicitly in the issue as workflow. Unconditionally sets `phase`/`current_agent`/`history` — used by the loop guard, execution-budget guard, and parallel-completion path. |
| Policy preflight block (main dispatch body) | 2386-2443 | Calls `scripts/preflight.rb` to allow/deny the dispatch based on `AI_DEV_OFFICE_INPUT_SOURCE` and repo policy. A workflow gate (should this task advance at all), not a runtime choice (which binary runs it). |
| `decision.yaml` reconciliation block | 2449-2483 | Applies a human's `approve`/`reject`/`request_changes`/`escalate` decision to `status.yaml` via `scripts/reconcile-decision.rb`, and may redirect which role gets dispatched. Core "review/reject/retry transition" logic named in the issue's box description. |
| validation_failed / reopen / blocked-dispatch / route-enforcement / loop-guard / execution-budget checkpoints | 2485-2617 | Named explicitly in the issue ("the loop_guard/execution_budget checkpoints"). All of it reads `status.yaml` fields and `office.config.yaml` policy, and its only actions are `exit 1` or calling `force_status_route` — no process invocation. |

## Runtime/execution

| Function / region | ~Lines | Why |
|---|---|---|
| `run_agent_invocation` | 41-47 | Re-execs `"$0"` (this same script) with the given args — the literal mechanism `auto` and the parallel-dev launcher use to start another dispatch. Pure process-invocation plumbing. |
| `record_run_start` / `record_run_update` | 784-802 | Named explicitly in the issue's spirit (run identity, client/model/runner metadata) — writes to `runs/<task>/run-records/`, keyed to *this execution*, not to task workflow state. |
| `runner_priority_values` / `runner_trigger_patterns` / `runner_retry_before_switch` / `next_runner_after` | 1210-1247 | Pure runner-selection policy: which binary to try, in what order, and what error text should trigger a fallback. |
| `runner_failure_pattern` | 1249-1262 | Greps a runner's log for a known "switch runners" signature — a runtime concern (is this failure retryable at the binary level), not a workflow one. |
| `run_runner_once` | 1281-1310 | Named explicitly in the issue. The only place that literally execs `codex`, shells to `cursor agent -p`, or writes the Cursor IDE prompt file. |
| `run_runner_with_fallback` | 1320-1386 | Named explicitly in the issue. Retry/fallback loop between runner binaries, driven by `runner_selector.*` config. |
| Prompt assembly section (`ALL_DEV_OUTPUTS`, `reviewed_artifact_paths`, `REVIEW_DEPTH_SECTION`, `PM_SECTION`/`PREV_SECTION`/`TASK_SECTION`/`STATUS_SECTION`, `build_context_index_section` and its helpers `yaml_file_text`/`context_task_is_code_impacting`/`context_queries_for_task`/`detect_context_provider`, final `PROMPT="..."` string) | 1394-1671, 2688-2802 | Named explicitly in the issue ("prompt assembly for a specific runner"). Assembles the literal text a runner subprocess receives. The *content selection* (which prior output, which risk depth) is workflow-informed, but the function of this code is producing a runner-facing prompt string, which is why it lands here rather than in Boundary/glue — see the note on `build_context_index_section` below. |
| `parallel_delay_seconds` | 2200-2206 | Jitter before launching a parallel OS process. Pure execution-timing detail. |
| Runner invocation + exit-code handling in the main dispatch body | 2828-2844 | `run_runner_with_fallback "$RUNNER"` call and the immediate `RUNNER_STATUS`-based `record_run_update`/`exit`. This narrow slice is pure "did the process succeed" handling; see Boundary/glue below for what happens to the result *after* this point. |

## Boundary/glue

| Function / region | ~Lines | Why it's boundary, not clean workflow or clean runtime |
|---|---|---|
| `ownership_apply_config_switch` / `ownership_parallel_lane` / `ownership_acquire` / `ownership_start_renewer` / `ownership_stop_renewer` / `ownership_release` | 804-919, 2384, 2812-2813, 2838, 2861, 2926, 2930 | Explicitly flagged in the issue as borderline; here's the call. The lease exists to answer a *runtime* question — is another live process (execution) already dispatching this task — but it is implemented by gating *workflow* writes: `sync_status_from_output`, `force_status_route`, and `reconcile_blocked_status` all call `TaskOwnership.fence!` before they touch `status.yaml`. So the concern (mutual exclusion between concurrent executions) is runtime, but the enforcement point (every workflow-state write) is workflow. A clean split would have the runtime layer hold the lease and simply refuse to *start* a conflicting execution, rather than having every workflow write independently re-check a runtime-owned lock. |
| `office_git_sync_publish` / `office_exit_handler` (the `EXIT`/`TERM`/`INT` traps) | 583-609 | Fires on *process exit* (a runtime lifecycle event) but performs *workflow-relevant* actions: releasing the ownership lease and publishing task state via git sync. A process-lifecycle hook doing task-state cleanup is exactly the kind of coupling the issue is describing. |
| `log_meta_event` and its call sites | 727-778, throughout | Structured event log (`meta.yaml`) recording both workflow events (`decision_applied`, `loop_guard`, `validation_failed`, `reopen_blocked`) and runtime events (`runner_failed`, `runner_retry`, `runner_switch`) through one shared writer, tagged with `run_id` when a dispatch is in flight. Not harmful, but it means workflow and runtime observability are inseparable in `meta.yaml` today — a query for "why did this task's phase change" and "why did the runner fail" hit the same file/writer. |
| `archive_reviewer_output_for_attempt` | 1264-1279 | Archives a workflow artifact (`reviewer-output.yaml`) every time the *runtime* retries a dispatch (keyed off `REVIEWER_OUTPUT_ATTEMPT`, incremented inside `run_runner_with_fallback`'s retry loop). Workflow-artifact housekeeping driven directly by a runtime retry counter. |
| `log_runner_failure` | 1314-1318 | Same shape as `log_meta_event` above but specific to runner failures — persists the transcript and logs `phase`/`iteration` (workflow context) alongside `runner`/`exit_code`/`classification` (runtime context) in one event. |
| `run_parallel_dev_agents` | 2208-2257 | Launches OS-level background processes (backgrounded subshells, `wait`, exit-code aggregation — runtime), but its *outcome* directly triggers a workflow decision one caller up (`mark_parallel_dev_complete` → `force_status_route`, or a hard failure that skips reviewer entirely). The function itself is runtime; the reason it exists at all is to feed a workflow decision. |
| `task_input_integrity_snapshot` / `task_input_integrity_verify` | 927-955, 2818-2826, 2846-2864 | A runtime mechanism (wraps the runner subprocess call) whose entire purpose is to produce a *workflow* trust decision: whether the resulting output is even eligible to be synced. The main dispatch body explicitly refuses to run `enforce-output-contract.rb`/`sync_status_from_output` when this check fails — runtime evidence gating a workflow transition, the textbook definition the issue gives for this bucket. |
| The `auto` pipeline `while` loop | 2619-2681 | See [`docs/orchestration-boundary.md` §4](orchestration-boundary.md#4-the-auto-loop-is-the-clearest-boundaryglue-example) for the full discussion. One loop body interleaves workflow decisions (`next_agent_from_output`, the parallel-plan validity check, the `NEXT == "done"` terminal check, the `pm`/`dev`/`reviewer` fallback-phase map) with a runtime action (`run_agent_invocation`, i.e. re-exec this script as a subprocess) on every iteration. |
| Post-run block: output-contract enforcement → status sync → validation | 2866-2929 | The other textbook example the issue names: "anywhere the runner's stdout/exit code is inspected to decide a WORKFLOW outcome." Concretely: `INTERACTIVE_RUNNER`/`OUTPUT_MTIME_EPOCH` (runtime facts about *this execution*) gate whether `enforce-output-contract.rb` and `sync_status_from_output` (workflow) even run at all; `enforce-output-contract.rb`'s own exit code then decides between two workflow outcomes (`validation_failed` vs. proceed to sync). |

### Boundary/glue: the `auto` loop

Line-level detail for the region called out in
[`docs/orchestration-boundary.md` §4](orchestration-boundary.md#4-the-auto-loop-is-the-clearest-boundaryglue-example):

```
STEP="pm"
while [[ -n "$STEP" ]]; do
  run_agent_invocation "$TASK_ID" "$STEP" "$RUNNER"   # <- runtime: re-exec this script
  STEP_OUTPUT="$TASK_DIR/${STEP}-output.yaml"
  NEXT="$(next_agent_from_output "$STEP" "$STEP_OUTPUT")"  # <- workflow: read next_action

  if [[ "$STEP" == "pm" ]]; then
    ...parallel_plan_agents...                         # <- workflow: validate PM's plan
    ...run_parallel_dev_agents...                       # <- runtime: launch parallel processes
    ...mark_parallel_dev_complete...                     # <- workflow: force route to reviewer
  fi

  if [[ -z "$NEXT" ]]; then ...fallback phase map... fi  # <- workflow: default next-role table
  if [[ "$NEXT" == "done" ]]; then exit 0; fi             # <- workflow: terminal check
  STEP="$NEXT"
done
```

A Phase 2 extraction would split this into a workflow-kernel function
(`decide_next_step(task_state) -> {role, is_parallel, is_terminal}`) and a
runtime adapter (`execute(role) -> output_file`), with `run_agent_invocation`
becoming one implementation of the adapter rather than the only one.

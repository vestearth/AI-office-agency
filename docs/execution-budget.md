# Execution Budget: Non-Progress Detection

A **deterministic, rule-based controller** that detects a task making no
meaningful progress and routes it to a terminal, human-visible state instead of
letting it loop silently. Implements #16.

Classifier: [`scripts/execution-budget.rb`](../scripts/execution-budget.rb).
Wired into `run-agent.sh` at the dispatch checkpoint immediately after the
existing loop-guard block (`loop_guard.max_iterations` /
`free_roam_max_iterations`), before any runner is invoked.

This is deliberately a **boring counter**, not a smart one. Every signal below
is two matching records, N logged events, or six alternating history rows —
explicit thresholds over a fixed vocabulary, never fuzzy or model-based
detection. That is the design goal, not a shortcut: an execution controller
that itself needs debugging defeats the point.

## Relationship to `loop_guard`

`execution_budget` is **layered on top of** `loop_guard`, not a replacement or
a fork of it:

- `loop_guard.max_iterations` / `free_roam_max_iterations` — unchanged, still
  the first check at the dispatch checkpoint. Counts raw iterations/free-roam
  passes regardless of whether anything productive happened in them.
- `loop_guard.validation_failed_retry_limit` — unchanged, still the
  unconditional halt at `validation_failed_retries >= limit`
  (`run-agent.sh`'s own dedicated block, `tests/integration/validation-failed-bounded.sh`).
  **`execution_budget` reads this exact key** for its own validation-failure
  signal (see below) rather than duplicating it under a new name that could
  disagree with the value the driver actually enforces. It was previously only
  a hardcoded code default (3); it is now named explicitly in
  `office.config.yaml` for exactly this reason — so both consumers read the
  same line.
- `execution_budget.max_no_progress_actions` / `on_exhausted` — new,
  additive. These are the only execution-budget-specific config keys.

Ordering at the checkpoint: `loop_guard` first, `execution_budget` second. An
iteration-count halt fires before this controller ever runs, unchanged from
before #16.

## Config

```yaml
execution_budget:
  enabled: true                 # kill switch; overridable via a local overlay
  max_no_progress_actions: 12   # protected — decides the no_new_evidence signal
  on_exhausted: escalate        # protected — decides the routing outcome
```

`enabled` is left overridable in `office.config.local.yaml`, matching
`dependency_guard.enabled` / `context_provider.enabled` — turning it off just
removes this one extra halt; `loop_guard`'s own halts still apply underneath
it. `max_no_progress_actions` and `on_exhausted` are protected in
`scripts/resolve-office-config.rb`'s `PROTECTED_PATHS`, the same as every
other outcome-determining key in the office, so a gitignored overlay cannot
quietly raise the ceiling or change what an exhausted run routes to.
`tests/integration/execution-budget.sh` does not re-assert the protection
mechanically (that pattern lives in `policy-preflight.sh` / `event-gateway.sh`
for their own key sets); the two keys are simply listed in `PROTECTED_PATHS`
next to the rest.

Only `on_exhausted: escalate` is implemented today (route to the existing
`escalated` phase). The key is kept explicit rather than hardcoded so a future
outcome needs a new value here, not a new key.

## Signals implemented

All four read exclusively from a task's own on-disk telemetry: `evidence.yaml`
(#13's ledger — `command`, `exit_code`, `artifact_sha256` of the captured
output), `meta.yaml` (`events[]`), and `status.yaml` (`phase`, `state`,
`validation_failed_retries`, `history[]`). Nothing is invented or observed live
from a runner; the classifier is a pure function of files already on disk.

| # | Signal | Trigger | "No material change" test |
|---|---|---|---|
| 1 | `repeated_command_failure` | the last two **failing** (`exit_code != 0`) evidence entries | same `command` string AND byte-identical `artifact_sha256` |
| 2 | `validation_failure_no_new_evidence` | `phase`/`state == validation_failed` AND `validation_failed_retries >= loop_guard.validation_failed_retry_limit` | the last two evidence entries (if any) have identical `command` + `artifact_sha256`; absent evidence is treated the same as an identical repeat |
| 3 | `no_new_evidence` | meta events logged since the last `evidence.yaml` append (or since the task began, if none exist) reach `max_no_progress_actions` | n/a — a pure count |
| 4 | `role_ping_pong` | the last 6 `status.yaml` history entries alternate between exactly one of the pairs `dev↔reviewer`, `dev↔debugger`, `dev-2↔reviewer`, `dev-2↔debugger`, with ≥3 alternations | no `evidence.yaml` entry's `executed_at` falls inside the window (`history.first.at` .. `history.last.at`) |

Classification order is `repeated_command_failure` →
`validation_failure_no_new_evidence` → `no_new_evidence` → `role_ping_pong`,
first match wins. The order is a documented, deterministic tie-break (cheapest
and most specific first), not a severity ranking.

## Retryable vs. exhausted

This is the property acceptance criterion 2 asks for, and it works
differently for signal 2 than for the other three:

- **Signals 1, 3, 4** are inherently retryable/exhausted binaries: they only
  fire on *positive* evidence of an unchanged repeat (identical output twice,
  N actions with zero evidence, six alternations with zero evidence growth). A
  task that fails once and then succeeds, or that logs a handful of actions
  before its next evidence append, never matches — see
  `tests/integration/execution-budget.sh` EB1b/EB3b/EB4b for the false-positive
  cases, and EB6 for the same property proven through the real driver.
- **Signal 2 is deliberately observational**, not a second halt mechanism. The
  actual halt on `validation_failed_retries >= limit` is `run-agent.sh`'s own
  pre-existing, unconditional block (M4) — it does not consult this
  classifier, and #16 does not change that. What `execution-budget.rb` adds is
  the ability to say, in the RECORDED reason, whether the failure that hit the
  cap carried a **genuinely new diagnosis** (different `artifact_sha256` on the
  last two evidence entries — see EB2c) or was an **identical repeat** (EB2).
  Both still halt at the cap either way; only the recorded reason differs. A
  run under the cap (EB2b — "2 of 3 allowed failures, then it would go on to
  succeed") is never flagged by anything in this file.

## Wiring

`run-agent.sh`, immediately after the existing `loop_guard` block and before
the `auto`-pipeline / dispatch:

```bash
if [[ "$AGENT" != "pm" && "$AGENT" != "auto" && "$AGENT" != "free-roam" \
      && -f "$STATUS_FILE" && "$EXECUTION_BUDGET_ENABLED" == "true" ]]; then
  EB_LINE="$(ruby "$OFFICE_DIR/scripts/execution-budget.rb" classify "$TASK_DIR" "$TASK_ID" "$AGENT")"
  # exhausted=true -> force_status_route(... "free-roam" "escalated" ...)
  #                    + log_meta_event(... "execution_budget" ...)
  #                    + exit 1
fi
```

`pm`/`auto`/`free-roam` are exempt for the same reasons the loop guard above it
exempts them: `pm` has no prior iteration to judge yet, `auto` re-enters this
same checkpoint on each of its own sub-dispatches, and `free-roam` is itself
the escalation target — refusing to dispatch it would make the halt
unrecoverable.

Routing reuses `force_status_route` — the exact function the free-roam loop
guard already calls — targeting the existing `escalated` phase and
`current_agent: free-roam`. No new phase was added; `escalated` already exists
in `validate-yaml.rb`'s `PHASES` and `schemas/status.schema.yaml`. The reason
is recorded twice, matching the existing `loop_guard` idiom:
`status.yaml.history[]` (via `force_status_route`) and a `meta.yaml` event of
type `execution_budget` (via `log_meta_event`) carrying `signal=` and
`reason=`.

## Signals scoped out, and why

The issue named seven candidate signals. Two are deliberately not implemented:

- **Same search/query repeated excessively** — no component in this office
  currently instruments individual search/query calls at a joinable
  granularity (`meta.yaml` logs coarse dispatch-lifecycle events, not
  per-tool-call queries). Building that instrumentation elsewhere in the
  codebase, purely to manufacture a signal for this file, is out of scope for
  #16 — it would be a second feature disguised as a detection rule.
- **Scope expansion beyond the task boundary** — #17/#19's gateway path has a
  clean "declared scope" (`preflight`'s `--path` list) to expand beyond. An
  ordinary `dev`/`reviewer`/`debugger` task has no equivalent declared
  boundary today; `task.md`/`status.yaml` do not carry one. Approximating this
  from `artifacts[]` paths against some inferred boundary would be exactly the
  unreliable heuristic the issue's "boring deterministic controller" framing
  warns against, so it is left for a future issue that first defines what a
  task's declared scope IS.

The "edit → revert → edit" and "repeated handoff between roles without state
improvement" candidates are covered by one signal, `role_ping_pong` (#4 in the
table above): `status.yaml.history[].agent` sequences are the only reliable,
already-recorded proxy for "the same two roles keep handing this back and
forth" — there is no per-file edit/revert log to detect the literal edit
sequence from.

## What this does not defend against

- **A run that fabricates evidence to dodge these signals** — e.g. running a
  trivial no-op command each cycle so `artifact_sha256` never repeats, or
  never calling `scripts/record-evidence.sh` at all so signal 3 has nothing to
  compare against. This file trusts the evidence ledger the same way every
  other consumer of #13's telemetry does; it is not an anti-gaming mechanism.
- **Non-progress that never touches evidence, meta events, or handoffs at
  all** — a task silently wedged with zero recorded activity produces no
  signal here (see "fail-open on missing telemetry" in
  `scripts/execution-budget.rb`'s header). `loop_guard.max_iterations`
  upstream of this file is the backstop for that case: it counts iterations
  regardless of what happened inside them.
- **A misconfigured `max_no_progress_actions` set absurdly high** — the value
  is protected against a *gitignored* overlay, not against the committed
  `office.config.yaml` itself. A deliberately-committed, reviewable change to
  raise it is out of scope for a runtime guard to prevent.

## Tests

`tests/integration/execution-budget.sh` — one case per signal (EB1/EB2/EB3/EB4),
a paired false-positive case for each (EB1b/EB2b(+EB2c)/EB3b/EB4b), the
fail-open case for missing/empty telemetry, and two real-driver cases (EB5:
halts before dispatch, 0 runner calls, routes to `escalated`/`free-roam`,
records the `execution_budget` meta event; EB6: a healthy task still dispatches
normally end-to-end).

`tests/integration/loop-guard-bounded.sh` and
`tests/integration/validation-failed-bounded.sh` are unchanged by #16 and were
re-run to confirm: both still pass byte-for-byte against the pre-#16 driver
behavior they pin.

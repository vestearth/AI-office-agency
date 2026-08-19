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

| # | Signal | In `classify`'s `SIGNAL_ORDER`? | Trigger | "No material change" test |
|---|---|---|---|---|
| 1 | `repeated_command_failure` | yes | the last two **failing** (`exit_code != 0`) evidence entries | same `command` string AND byte-identical `artifact_sha256`, **AND nothing meaningful logged strictly between them** — no non-routine `meta.yaml` event and no other `evidence.yaml` entry (see "Fix 2: intervening activity" below) |
| 2 | `validation_failure_no_new_evidence` | **no — annotation only** | `phase`/`state == validation_failed` AND `validation_failed_retries >= loop_guard.validation_failed_retry_limit` | the last two evidence entries (if any) have identical `command` + `artifact_sha256`; absent evidence is treated the same as an identical repeat |
| 3 | `no_new_evidence` | yes | meta events logged since the last `evidence.yaml` append (or since the task began, if none exist) reach `max_no_progress_actions` | n/a — a pure count |
| 4 | `role_ping_pong` | yes | the last 6 `status.yaml` history entries alternate between exactly one of the pairs `dev↔reviewer`, `dev↔debugger`, `dev-2↔reviewer`, `dev-2↔debugger`, with ≥3 alternations | no `evidence.yaml` entry's `executed_at` falls inside the window (`history.first.at` .. `history.last.at`) |

`classify`'s `SIGNAL_ORDER` is `repeated_command_failure` → `no_new_evidence` →
`role_ping_pong`, first match wins — signal 2 is deliberately **excluded** from
this list (see "Retryable vs. exhausted" below). The order among the three that
remain is a documented, deterministic tie-break (cheapest and most specific
first), not a severity ranking.

### Fix 2: intervening activity ("no material change" precisely)

Signal 1's byte-identical-output check alone cannot tell a stuck loop (rerun,
nothing new, rerun again) apart from a legitimate **baseline-then-confirm**
rerun — fail, diagnose, rerun the SAME command to *confirm* the repro before
applying the actual fix. Both produce byte-identical output on the second run.

The distinction is `ExecutionBudget.meaningful_activity_between?`: it looks for
either (a) a `meta.yaml` event, strictly between the two evidence timestamps,
whose `type` is **not** in the routine bookkeeping allowlist
(`ROUTINE_META_EVENT_TYPES` — the event types `run-agent.sh` itself writes
around every dispatch regardless of whether real work happened:
`prompt_assembly`, `runner_complete`, `runner_failed`, `runner_retry`,
`runner_switch`, `ownership_acquired`, `context_provider`, `loop_guard`,
`execution_budget`, `decision_applied`, `reopen_blocked`), or (b) any OTHER
`evidence.yaml` entry (even a passing one) in that same window. If either is
present, the repeat is not flagged.

The allowlist is deliberately the narrow side: a routine type is named
explicitly as "does not count", and anything not on that list — including an
event type that does not exist yet — counts as meaningful by default. This
means a new automatic bookkeeping event added to `log_meta_event`'s callers in
the future must be added to the allowlist explicitly, or it silently starts
rescuing repeats from being flagged; the reverse mistake (a real diagnostic
event failing to rescue a repeat) cannot happen by construction.
`tests/integration/execution-budget.sh` EB1c proves the rescue case (a
`diagnosis`-typed event in between); EB1d is the control proving a routine
`prompt_assembly` event does NOT rescue it.

## Retryable vs. exhausted

This is the property acceptance criterion 2 asks for, and it works
differently for signal 2 than for the other three:

- **Signals 1, 3, 4** are inherently retryable/exhausted binaries, decided
  entirely by `classify` (which `run-agent.sh`'s checkpoint uses to gate the
  dispatch): they only fire on *positive* evidence of an unchanged repeat
  (identical output twice with nothing meaningful in between, N actions with
  zero evidence, six alternations with zero evidence growth). A task that
  fails once and then succeeds, or that logs a handful of actions before its
  next evidence append, never matches — see
  `tests/integration/execution-budget.sh` EB1b/EB1c/EB3b/EB4b for the
  false-positive cases, and EB6 for the same property proven through the real
  driver.
- **Signal 2 is annotation-only and is excluded from `SIGNAL_ORDER`** — it can
  never make `classify` return `exhausted=true`, and it is reached only
  through the separate `ExecutionBudget.validation_failure_annotation` /
  `annotate-validation-failure` CLI command. The actual halt on
  `validation_failed_retries >= limit` stays entirely `run-agent.sh`'s own
  pre-existing, unconditional M4 block, including its
  `AI_DEV_OFFICE_FORCE=true` operator override — #16 does not touch that
  block's control flow, only enriches its recorded reason (best-effort,
  wrapped in `|| true`, after the halt has already unconditionally fired).
  What `execution-budget.rb` adds is the ability to say, in that RECORDED
  reason, whether the failure that hit the cap carried a **genuinely new
  diagnosis** (different `artifact_sha256` on the last two evidence entries —
  see EB2c) or was an **identical repeat** (EB2). Both still halt at the cap
  either way; only the recorded reason differs. A run under the cap (EB2b —
  "2 of 3 allowed failures, then it would go on to succeed") annotates
  `applicable=false` and is never touched by anything in this file.

  **This design changed during review.** An earlier revision put signal 2 in
  `SIGNAL_ORDER`, so `run-agent.sh`'s NEW execution-budget checkpoint (not
  M4) would independently re-evaluate `validation_failed_retries >= limit`
  and force-escalate on its own — with no `AI_DEV_OFFICE_FORCE` check,
  because that checkpoint is new code that had never needed one. The result:
  an operator setting `AI_DEV_OFFICE_FORCE=true` specifically to give `dev`
  one more shot past M4's halt would have that override silently defeated by
  a *second*, undocumented halt one checkpoint later — work discarded, with a
  plausible-sounding "no progress" reason that gave no hint an override had
  even been attempted. An independent audit caught this by reproducing it
  end-to-end through the real driver. The fix is the exclusion above, proven
  by `tests/integration/execution-budget.sh` EB2-classify-noop (classifier
  level) and EB8 (real driver, `AI_DEV_OFFICE_FORCE=true` end-to-end,
  reproducing the audit's exact scenario and confirming the runner is now
  called).

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

`pm`/`auto`/`free-roam` are all skipped here, but **not for one uniform
reason** — this is not "the same treatment the loop guard above gives them".
`loop_guard`'s own block only hard-exempts `pm`; it still evaluates `auto` and
`free-roam` through its own `max_iterations` / `free_roam_max_iterations`
checks. This checkpoint skips all three, for three different reasons: `pm` has
no prior iteration to judge yet; `auto` re-enters THIS SAME checkpoint on each
of its own per-step sub-dispatches, so skipping the umbrella call is not
skipping the check (`tests/integration/execution-budget.sh` does not need to
prove this separately — `auto`'s per-step dispatches are the same code path
EB5-EB8 already exercise); and `free-roam` is the escalation target itself, so
flagging it here would make the halt unrecoverable. `tests/integration/execution-budget.sh`
EB7 proves the `pm` exemption specifically, with a fixture engineered so every
signal in `SIGNAL_ORDER` would otherwise fire — a mutation-coverage gap an
independent audit found (removing the `pm` guard survived all 13 pre-existing
regression suites with no test catching it).

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
- **`no_new_evidence` is content-blind** — it counts meta events since the
  last evidence append, and does not read what those events say. Twelve real,
  substantive events with legitimately zero evidence recorded yet (e.g. a
  long design/discovery stretch before the first test is written) can trip
  it. In practice the real-world trigger surface is narrower than the raw
  threshold suggests: `meta.yaml` is written only by `run-agent.sh`'s own
  infra logging (`log_meta_event` calls around dispatch lifecycle, ownership,
  loop guards, etc.), not per agent tool-call — so reaching 12 typically
  spans several full dispatch cycles of a task, not one long single turn.
- **A misconfigured `max_no_progress_actions` set absurdly high** — the value
  is protected against a *gitignored* overlay, not against the committed
  `office.config.yaml` itself. A deliberately-committed, reviewable change to
  raise it is out of scope for a runtime guard to prevent.

## Tests

`tests/integration/execution-budget.sh`:

- **EB1/EB1b/EB1c/EB1d** — `repeated_command_failure`: flags an identical
  repeat (EB1), does not flag a fixed/different retry (EB1b), does not flag a
  legitimate baseline-then-confirm rerun with a real diagnosis logged in
  between (EB1c, Fix 2), and the control proving a routine bookkeeping event
  in between does NOT rescue a genuine repeat (EB1d).
- **EB2/EB2-classify-noop/EB2b/EB2c** — the validation-failure annotation:
  applicable with the right reason at the cap (EB2), proof that `classify`
  itself never flags on this signal (EB2-classify-noop, Fix 1), not
  applicable under the cap (EB2b), and the "new evidence" reason variant at
  the cap (EB2c).
- **EB3/EB3b** — `no_new_evidence`: flags at the threshold, does not flag
  under it.
- **EB4/EB4b** — `role_ping_pong`: flags on alternation with no evidence
  growth, does not flag when evidence grew in the window.
- **EB-missing** — fail-open on a missing/empty task dir.
- **EB5/EB6** — real-driver cases: EB5 halts before dispatch (0 runner calls),
  routes to `escalated`/`free-roam`, records the `execution_budget` meta
  event; EB6 shows a healthy task still dispatches normally end-to-end.
- **EB7** — real-driver `pm` exemption (Fix 3): a fixture engineered so every
  `SIGNAL_ORDER` signal would otherwise fire, dispatched as `pm`, must still
  call the runner.
- **EB8** — real-driver `AI_DEV_OFFICE_FORCE=true` end-to-end (Fix 1): the
  independent audit's exact reproduction (`validation_failed_retries` at the
  cap, FORCE set, `dev` dispatched) must call the runner and must not be
  touched by the execution-budget checkpoint.

`tests/integration/loop-guard-bounded.sh` and
`tests/integration/validation-failed-bounded.sh` are unchanged by #16 and were
re-run to confirm: both still pass byte-for-byte against the pre-#16 driver
behavior they pin.

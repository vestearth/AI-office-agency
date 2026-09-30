# Completion Gates (Phase 1A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A task that declares completion gates cannot reach `done` through any supported writer while a gate is unresolved, and every gate resolution is explicit and auditable.

**Architecture:** One runtime-independent Ruby module (`scripts/completion-guard.rb`) owns the invariant "may this status transition to `done`". The three status writers that can produce `done` (`sync-status-from-output.rb`, `reconcile-decision.rb`, `force-status-route.rb`), the auto-loop decision script, and the stored-state validator all call it — no gate logic is copied. A single governed writer (`scripts/update-completion-gate.rb`) is the only sanctioned way to declare or resolve a gate. Everything is opt-in inside `status.yaml`; tasks without `completion_gates` behave exactly as today.

**Tech Stack:** Ruby (stdlib `yaml`, `date`, `time`), bash integration tests under `tests/integration/`, existing `validate-yaml.rb` / `schemas/status.schema.yaml` / `tests/integration/schema-validator-parity.sh`.

**Spec:** GitHub issue [vestearth/AI-office-agency#28](https://github.com/vestearth/AI-office-agency/issues/28) — the maintainer comment "Phase 1A design decisions — freeze for implementation" (items 1–12 and tests A–G) plus the later "Phase 1A known limitation — confirmed" comment. This plan implements exactly that; where the plan makes a call the freeze left open it is listed under "Decisions this plan makes" below.

## Global Constraints

Copied from the frozen spec; every task inherits these.

- No `execution.yaml`, no branch state, no failure classification, no action-scoped authorization, no automatic gate discovery, no multi-agent selection (Phase 1A boundary).
- Gate statuses are exactly `pending`, `pass`, `na`. No `failed`, `waived`, `skipped`.
- A gate present under `completion_gates` is required. There is no `required:` flag.
- `pass` and `na` require `actor`, `reason`, `updated_at`. `evidence_refs` are optional, but when present each id must resolve in the task's `evidence.yaml` (structural check only — the validator never judges whether evidence proves acceptance).
- Do **not** add a new evidence type (no `human_attestation`).
- Refusing `done` keeps the current phase, does **not** route to `validation_failed`, does **not** increment `validation_failed_retries`, and records a `completion_blocked` event in `meta.yaml`.
- `force-status-route ... done` is bound by the same guard. No bypass.
- Tasks with no `completion_gates` key must behave byte-for-byte as before.
- No new field may exist in only one of: `schemas/status.schema.yaml`, `validate-yaml.rb`, parity coverage, `docs/task-transition-contract.md`, the runtime writers.
- Real `.env` files are read-only and no secrets go in the repo (workspace guardrail 1); this change touches none.
- This repo is a meta/tooling repo, so no `TASK-` run is required (workspace `CLAUDE.md`, "Exception — meta/tooling repos").
- Do not run `git push`, and do not edit an already-applied migration (none are involved).

## Decisions this plan makes (the freeze left these open)

1. **Refusal exit code is `5`.** `sync-status-from-output.rb` and `force-status-route.rb` exit `5` (`CompletionGuard::COMPLETION_BLOCKED`) on refusal. The existing driver already treats any sync exit other than `0`/`3` as "aborted, not propagating" with no retry counter, so `5` reaches the intended behavior with one small message branch.
2. **A refused human `approve` stays queued.** `reconcile-decision.rb` prints `blocked:approve:<gates>`, exits `0`, and does **not** set `decision_applied_at`. The decision therefore re-attempts on the next dispatch and applies automatically once the gates resolve; a newer decision still supersedes it (existing "latest decision wins" rule). The `completion_blocked` event is de-duplicated (skipped when the newest event is an identical `completion_blocked`), so re-attempts do not spam `meta.yaml`.
3. **`decide-next-step.rb` is a fifth `done` path.** It reads only the output file and returns `terminal=true`, which makes the `auto` loop print "Task … completed!" even when the sync was refused. It gets an optional third argument (`STATUS_FILE`) and reports `terminal=false` when the guard blocks. This is not in the freeze's list of three writers; it is included because otherwise the operator is told the task is complete when it is not.
4. **Gate edits are refused on `done`/`aborted` tasks**, so the helper can never manufacture the impossible state `done + pending`.
5. **Meta events are appended by the scripts themselves** (under the `.lock` the caller already holds) rather than only by `run-agent.sh`'s `log_meta_event`, so the scripts stay usable without the driver.
6. **`actor` is free text.** Per the confirmed limitation, nothing verifies identity or independence. `meta.yaml` event `agent` values must be one of the validator's `STATUS_ACTORS`; a free-text actor outside that set is recorded as `orchestrator` on the event and kept verbatim in `details`.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `scripts/completion-guard.rb` | Create | `CompletionGuard` module: the invariant, the shared constants, and the lock-free meta event appender. No CLI, safe to `require`. |
| `scripts/update-completion-gate.rb` | Create | The one governed writer: `declare` / `pass` / `na`. Lock + ownership fence + history + meta event. |
| `scripts/sync-status-from-output.rb` | Modify | Call the guard before writing `done`; exit `5` on refusal. |
| `scripts/reconcile-decision.rb` | Modify | Call the guard before applying `approve`; print `blocked:…`, leave decision unapplied. |
| `scripts/force-status-route.rb` | Modify | Call the guard before writing `done`; exit `5` on refusal. |
| `scripts/decide-next-step.rb` | Modify | Optional `STATUS_FILE` arg; `terminal=false` when the guard blocks. |
| `run-agent.sh` | Modify | Message branch for sync rc `5`; message for `blocked:*` decision result; pass `$STATUS_FILE` to `decide_next_step`. |
| `validate-yaml.rb` | Modify | Shape rules for `completion_gates`, the `done`+unresolved invariant, evidence-ref resolution. |
| `schemas/status.schema.yaml` | Modify | Document `completion_gates`. |
| `tests/integration/schema-validator-parity.sh` | Modify | Pin `CompletionGuard::GATE_STATUSES` to the schema enum. |
| `tests/integration/completion-gates.sh` | Create | All Phase 1A tests (A–G, dependency release, auto-loop, backward compatibility). |
| `docs/completion-gates.md` | Create | The contract and the guarantee wording, including the limitation. |
| `docs/task-transition-contract.md` | Modify | Refresh stale coupling point #1; note `completion_gates`. |

All paths are relative to the `ai-dev-office/` repo root (`/Users/earth/Documents/GitHub/ai-dev-office`). Run every command from there.

## Preflight (do once, before Task 1)

- [ ] **Step 1: Create a working branch**

```bash
cd /Users/earth/Documents/GitHub/ai-dev-office
git status --short
git checkout -b feat/issue-28-completion-gates
```

Expected: `git status --short` prints nothing that you did not put there (the plan file itself may show as untracked). If unrelated modifications appear, stop and ask — they belong to another live session.

- [ ] **Step 2: Record the baseline**

Run the suites this change can affect and keep the output so a regression can be told apart from a pre-existing failure:

```bash
for t in schema-validator-parity decision-reconcile state-machine-consistency \
         concurrent-status-writes idempotency-and-reentry validation-failed-bounded \
         output-contract dependency-policy dependency-guard evidence-contract \
         auto-parallel task-ownership; do
  if bash "tests/integration/$t.sh" >/tmp/baseline-$t.log 2>&1; then echo "PASS $t"; else echo "FAIL $t"; fi
done
```

Expected: note which (if any) already FAIL. Only new failures after your change count as regressions.

---

### Task 1: The shared completion guard

**Files:**
- Create: `scripts/completion-guard.rb`
- Create: `tests/integration/completion-gates.sh`

**Interfaces:**
- Produces (all later tasks rely on these exact names):
  - `CompletionGuard::GATE_STATUSES` → `%w[pending pass na]`
  - `CompletionGuard::GATE_NAME_PATTERN` → `/\A[a-z][a-z0-9_]*\z/`
  - `CompletionGuard::COMPLETION_BLOCKED` → `5`
  - `CompletionGuard::STATUS_ACTORS` → `%w[pm dev dev-2 reviewer debugger devops free-roam done orchestrator]`
  - `CompletionGuard::Verdict` — `Struct.new(:allowed, :unresolved)`
  - `CompletionGuard.can_transition_to_done(status)` → `Verdict` (`status` is the parsed `status.yaml` Hash)
  - `CompletionGuard.blocked_message(unresolved)` → `String`
  - `CompletionGuard.event_agent(actor)` → one of `STATUS_ACTORS`
  - `CompletionGuard.append_meta_event!(task_dir, type:, agent:, details:, dedupe: false)` → `true` if appended, `false` if skipped as a duplicate. **Caller must already hold the task `.lock`** (it does not lock).
  - `CompletionGuard.record_blocked!(task_dir, attempted:, actor:, unresolved:)` → same return as above; writes a `completion_blocked` event with `details: "attempted=<attempted> unresolved=<a,b>"`, de-duplicated.

- [ ] **Step 1: Write the failing test file**

Create `tests/integration/completion-gates.sh` with exactly this content. Later tasks append sections above the final `echo` line (marked `# --- APPEND-NEW-SECTIONS-ABOVE ---`).

```bash
#!/usr/bin/env bash
set -euo pipefail

# Issue #28 Phase 1A — completion gates.
#
# A task that declares `completion_gates` in status.yaml cannot reach `done`
# through any supported writer while a gate is unresolved. Tasks with no
# `completion_gates` behave exactly as before.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SYNC="$ROOT_DIR/scripts/sync-status-from-output.rb"
RECONCILE="$ROOT_DIR/scripts/reconcile-decision.rb"
FORCE="$ROOT_DIR/scripts/force-status-route.rb"
DECIDE="$ROOT_DIR/scripts/decide-next-step.rb"
GATE="$ROOT_DIR/scripts/update-completion-gate.rb"
BLOCKED_STATUS="$ROOT_DIR/scripts/reconcile-blocked-status.rb"
VALIDATOR="$ROOT_DIR/validate-yaml.rb"

TMP_RUNS="$(mktemp -d)"
export AI_OFFICE_RUNS_DIR="$TMP_RUNS"
# The ownership fence is irrelevant here: no ownership.yaml exists, so writes
# are ungoverned-and-allowed. Make sure a leaked epoch from a parent run
# cannot change that.
unset AI_DEV_OFFICE_OWNERSHIP_EPOCH AI_DEV_OFFICE_RUN_ID
trap 'rm -rf "$TMP_RUNS"' EXIT

fail() { echo "[FAIL] $1"; exit 1; }

assert_eq() {
  if [[ "$1" != "$2" ]]; then echo "[FAIL] $3: expected '$1' got '$2'"; exit 1; fi
}

# yaml_get <file> <dotted.key.path> — prints the value, or empty when absent.
yaml_get() {
  ruby - "$1" "$2" <<'RUBY'
require "yaml"; require "date"
d = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time], aliases: true) || {}
v = ARGV[1].split(".").reduce(d) { |n, k| n.is_a?(Hash) ? n[k] : nil }
puts v.nil? ? "" : v.to_s
RUBY
}

# event_count <task_dir> <type> — number of meta.yaml events of that type.
event_count() {
  ruby - "$1/meta.yaml" "$2" <<'RUBY'
require "yaml"; require "date"
path, type = ARGV
unless File.exist?(path)
  puts 0
  exit 0
end
d = YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}
puts Array(d["events"]).count { |e| e.is_a?(Hash) && e["type"] == type }
RUBY
}

# last_event_details <task_dir> <type>
last_event_details() {
  ruby - "$1/meta.yaml" "$2" <<'RUBY'
require "yaml"; require "date"
path, type = ARGV
d = YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}
e = Array(d["events"]).reverse.find { |x| x.is_a?(Hash) && x["type"] == type }
puts e ? e["details"].to_s : ""
RUBY
}

new_task() {  # <task_id> — creates and echoes the task dir
  local dir="$TMP_RUNS/$1"
  mkdir -p "$dir"
  echo "$dir"
}

# write_status <task_dir> <task_id> <phase> [<extra yaml, already indented as top-level keys>]
write_status() {
  cat > "$1/status.yaml" <<YAML
task_id: $2
phase: $3
state: $3
iteration: 1
current_agent: reviewer
${4:-}
YAML
}

write_reviewer_approved() {  # <task_dir>
  cat > "$1/reviewer-output.yaml" <<'YAML'
review_verdict: approved
next_action:
  agent: done
  reason: approved
YAML
}

PENDING_GATE='completion_gates:
  authenticated_runtime:
    status: pending
    evidence_refs: []'

# ---------------------------------------------------------------------------
# Task 1 — the shared guard (unit level)
# ---------------------------------------------------------------------------
ruby - "$ROOT_DIR" <<'RUBY'
require File.join(ARGV[0], "scripts", "completion-guard")

def check(cond, msg)
  abort "[FAIL] guard: #{msg}" unless cond
end

allowed = CompletionGuard.can_transition_to_done({})
check allowed.allowed && allowed.unresolved.empty?, "no completion_gates key must allow done (backward compatible)"

check CompletionGuard.can_transition_to_done({ "completion_gates" => {} }).allowed,
      "an empty completion_gates map must allow done"

pending = CompletionGuard.can_transition_to_done(
  "completion_gates" => { "authenticated_runtime" => { "status" => "pending" } }
)
check !pending.allowed && pending.unresolved == ["authenticated_runtime"], "pending gate must block done"

mixed = CompletionGuard.can_transition_to_done(
  "completion_gates" => {
    "source_verification" => { "status" => "pass" },
    "deployment" => { "status" => "na" },
    "authenticated_runtime" => { "status" => "pending" },
    "another" => { "status" => "pending" }
  }
)
check mixed.unresolved == %w[another authenticated_runtime], "unresolved must be the sorted pending gate names, got #{mixed.unresolved.inspect}"

resolved = CompletionGuard.can_transition_to_done(
  "completion_gates" => { "a" => { "status" => "pass" }, "b" => { "status" => "na" } }
)
check resolved.allowed, "all pass/na must allow done"

# Fail closed on malformed state: a gate the guard cannot read is not resolved.
check !CompletionGuard.can_transition_to_done("completion_gates" => { "a" => "pass" }).allowed,
      "a non-map gate record must block done"
check !CompletionGuard.can_transition_to_done("completion_gates" => { "a" => { "status" => "passed" } }).allowed,
      "an unknown gate status must block done"
check !CompletionGuard.can_transition_to_done("completion_gates" => ["a"]).allowed,
      "a non-map completion_gates must block done"

check CompletionGuard.blocked_message(%w[a b]).include?("a, b"), "message must name every unresolved gate"
check CompletionGuard.event_agent("reviewer") == "reviewer", "known actor maps to itself"
check CompletionGuard.event_agent("Sichol") == "orchestrator", "free-text actor maps to orchestrator on events"
check CompletionGuard::GATE_STATUSES == %w[pending pass na], "gate statuses are exactly pending/pass/na"
check CompletionGuard::COMPLETION_BLOCKED == 5, "refusal exit code is 5"
RUBY
echo "[ok] completion-guard unit checks"

# --- APPEND-NEW-SECTIONS-ABOVE ---
echo "PASS: completion-gates"
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bash tests/integration/completion-gates.sh
```

Expected: FAIL with a Ruby `LoadError` — `cannot load such file … scripts/completion-guard` (the module does not exist yet).

- [ ] **Step 3: Write the guard**

Create `scripts/completion-guard.rb`:

```ruby
#!/usr/bin/env ruby
# frozen_string_literal: true

# Completion gates (issue #28, Phase 1A) — the one place that answers
# "may this task transition to `done` now?".
#
# A task opts in by declaring `completion_gates` in status.yaml. A gate that is
# present is REQUIRED (there is no `required:` flag). A gate is resolved only
# when its status is `pass` or `na`; `pending` — and anything the guard cannot
# read — blocks `done`. Tasks with no `completion_gates` key are unaffected.
#
# Every writer that can produce `done` calls can_transition_to_done, and the
# stored-state validator calls it too (defense in depth). Do not copy this
# logic into a writer.
#
# This file is a library: it has no CLI and is safe to `require`.

require "yaml"
require "date"
require "time"

module CompletionGuard
  GATE_STATUSES = %w[pending pass na].freeze
  GATE_NAME_PATTERN = /\A[a-z][a-z0-9_]*\z/.freeze
  RESOLVED_STATUSES = %w[pass na].freeze
  # Exit code a status writer uses when the guard refuses `done`. Distinct from
  # 3 (malformed output -> validation_failed) on purpose: a legitimate wait for
  # runtime acceptance is not a validation defect.
  COMPLETION_BLOCKED = 5
  # Mirrors validate-yaml.rb STATUS_ACTORS (meta.yaml event `agent` enum).
  STATUS_ACTORS = %w[pm dev dev-2 reviewer debugger devops free-roam done orchestrator].freeze

  Verdict = Struct.new(:allowed, :unresolved)

  module_function

  # status is the parsed status.yaml Hash. Returns a Verdict; `unresolved` is a
  # sorted Array of gate names (or ["completion_gates"] when the key itself is
  # malformed — fail closed).
  def can_transition_to_done(status)
    return Verdict.new(true, []) unless status.is_a?(Hash) && status.key?("completion_gates")

    gates = status["completion_gates"]
    return Verdict.new(false, ["completion_gates"]) unless gates.is_a?(Hash)

    unresolved = gates.reject { |_name, gate| resolved?(gate) }.keys.map(&:to_s).sort
    Verdict.new(unresolved.empty?, unresolved)
  end

  def resolved?(gate)
    gate.is_a?(Hash) && RESOLVED_STATUSES.include?(gate["status"].to_s)
  end

  def blocked_message(unresolved)
    "Completion blocked: unresolved completion gate(s): #{unresolved.join(', ')}. " \
      "Resolve each with scripts/update-completion-gate.rb (pass|na) before the task can be marked done."
  end

  # meta.yaml event `agent` must be a STATUS_ACTORS value. `actor` on a gate is
  # free text (Phase 1A does not verify identity), so anything else is recorded
  # as `orchestrator` on the event and kept verbatim in `details`.
  def event_agent(actor)
    STATUS_ACTORS.include?(actor.to_s) ? actor.to_s : "orchestrator"
  end

  # Appends one event to runs/<task>/meta.yaml. The CALLER MUST ALREADY HOLD the
  # task `.lock` — status writers do; this method deliberately does not lock
  # (a second flock on the same file from the same process would deadlock).
  # Observability must never turn a refusal into a crash, so I/O and YAML
  # problems are reported on stderr and swallowed.
  def append_meta_event!(task_dir, type:, agent:, details:, dedupe: false)
    meta_path = File.join(task_dir, "meta.yaml")
    meta = if File.exist?(meta_path)
             YAML.safe_load(File.read(meta_path), permitted_classes: [Date, Time], aliases: true) || {}
           else
             {}
           end
    meta["task_id"] ||= File.basename(task_dir)
    meta["events"] = [] unless meta["events"].is_a?(Array)

    if dedupe
      last = meta["events"].last
      return false if last.is_a?(Hash) && last["type"] == type && last["details"] == details
    end

    timestamp = Time.now.utc.strftime("%FT%TZ")
    event = { "type" => type, "agent" => agent, "details" => details, "timestamp" => timestamp }
    run_id = ENV["AI_DEV_OFFICE_RUN_ID"].to_s
    event["run_id"] = run_id unless run_id.empty?
    meta["events"] << event
    meta["updated_at"] = timestamp

    tmp_path = "#{meta_path}.tmp.#{$$}"
    begin
      File.write(tmp_path, YAML.dump(meta))
      File.rename(tmp_path, meta_path)
    rescue StandardError
      File.delete(tmp_path) if File.exist?(tmp_path)
      raise
    end
    true
  rescue StandardError => e
    warn "completion-guard: could not record #{type} event in #{meta_path}: #{e.message}"
    false
  end

  # The event written whenever the guard refuses a transition to done.
  def record_blocked!(task_dir, attempted:, actor:, unresolved:)
    append_meta_event!(
      task_dir,
      type: "completion_blocked",
      agent: event_agent(actor),
      details: "attempted=#{attempted} unresolved=#{unresolved.join(',')}",
      dedupe: true
    )
  end
end
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bash tests/integration/completion-gates.sh
```

Expected: `[ok] completion-guard unit checks` then `PASS: completion-gates`.

- [ ] **Step 5: Commit**

```bash
git add scripts/completion-guard.rb tests/integration/completion-gates.sh
git commit -m "feat(completion-gates): add shared completion guard (#28 Phase 1A)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Enforce the guard in the three status writers (tests A, B, C)

**Files:**
- Modify: `scripts/sync-status-from-output.rb` (require near line 32; guard after the `new_phase` computation, before `work_agents = …`, currently line ~152; header `Exit:` comment)
- Modify: `scripts/reconcile-decision.rb` (require; guard between `prev_phase = …` and `status["phase"] = …`)
- Modify: `scripts/force-status-route.rb` (require; guard after `old_phase` is computed; header `Exit:` comment)
- Modify: `run-agent.sh` (sync rc branch near line 2500; decision result message near line 2075)
- Modify: `tests/integration/completion-gates.sh`

**Interfaces:**
- Consumes: `CompletionGuard.can_transition_to_done`, `.blocked_message`, `.record_blocked!`, `CompletionGuard::COMPLETION_BLOCKED` (Task 1).
- Produces: exit `5` from `sync-status-from-output.rb` and `force-status-route.rb` on refusal; stdout line `blocked:approve:<gate1,gate2>` (exit `0`) from `reconcile-decision.rb`; a `completion_blocked` event in `meta.yaml` in all three cases.

- [ ] **Step 1: Append the failing tests**

Insert this block immediately above the `# --- APPEND-NEW-SECTIONS-ABOVE ---` line in `tests/integration/completion-gates.sh`:

```bash
# ---------------------------------------------------------------------------
# Task 2 — the three writers are bound by the guard
# ---------------------------------------------------------------------------

# Test A — VS-008-style pending runtime gate: reviewer approval is refused.
DIR="$(new_task TASK-901)"
write_status "$DIR" TASK-901 review "$PENDING_GATE"
write_reviewer_approved "$DIR"
rc=0
ruby "$SYNC" TASK-901 reviewer "$DIR/status.yaml" "$DIR/reviewer-output.yaml" 2026-09-30 in_review >/dev/null 2>"$TMP_RUNS/err" || rc=$?
assert_eq "5" "$rc" "A: sync must exit 5 (completion blocked)"
grep -q "authenticated_runtime" "$TMP_RUNS/err" || fail "A: the refusal must name the unresolved gate"
assert_eq "review" "$(yaml_get "$DIR/status.yaml" phase)" "A: phase must stay review"
assert_eq "reviewer" "$(yaml_get "$DIR/status.yaml" current_agent)" "A: routing must not change"
assert_eq "" "$(yaml_get "$DIR/status.yaml" validation_failed_retries)" "A: no validation retry consumed"
assert_eq "" "$(yaml_get "$DIR/status.yaml" last_synced_output.digest)" "A: refused output must not be recorded as synced"
assert_eq "1" "$(event_count "$DIR" completion_blocked)" "A: one completion_blocked event"
assert_eq "attempted=review -> done unresolved=authenticated_runtime" \
  "$(last_event_details "$DIR" completion_blocked)" "A: event carries the attempted transition and unresolved gates"

# Re-running the same refused sync is de-duplicated, not spammed.
rc=0
ruby "$SYNC" TASK-901 reviewer "$DIR/status.yaml" "$DIR/reviewer-output.yaml" 2026-09-30 in_review >/dev/null 2>&1 || rc=$?
assert_eq "5" "$rc" "A: a retry is refused the same way"
assert_eq "1" "$(event_count "$DIR" completion_blocked)" "A: an identical refusal is not logged twice"

# Test B — a human `approve` must not bypass the invariant (approve -> done).
DIR="$(new_task TASK-902)"
write_status "$DIR" TASK-902 in_review "$PENDING_GATE"
cat > "$DIR/decision.yaml" <<'YAML'
task_id: TASK-902
decisions:
  - decision: approve
    actor: alice
    decided_at: "2026-09-30T01:00:00Z"
YAML
out="$(ruby "$RECONCILE" TASK-902 2>/dev/null)"
assert_eq "blocked:approve:authenticated_runtime" "$out" "B: reconcile must report the held decision"
assert_eq "in_review" "$(yaml_get "$DIR/status.yaml" phase)" "B: task must not become done"
assert_eq "" "$(yaml_get "$DIR/status.yaml" decision_applied_at)" "B: a held decision stays pending, not applied"
assert_eq "1" "$(event_count "$DIR" completion_blocked)" "B: completion_blocked recorded"
out="$(ruby "$RECONCILE" TASK-902 2>/dev/null)"
assert_eq "blocked:approve:authenticated_runtime" "$out" "B: still held on the next dispatch"
assert_eq "1" "$(event_count "$DIR" completion_blocked)" "B: repeat attempts are de-duplicated"

# Test C — force-status-route ... done is bound by the same guard.
DIR="$(new_task TASK-903)"
write_status "$DIR" TASK-903 review "$PENDING_GATE"
rc=0
ruby "$FORCE" TASK-903 "$DIR/status.yaml" 2026-09-30 done done orchestrator "operator forced done" >/dev/null 2>&1 || rc=$?
assert_eq "5" "$rc" "C: force ... done must be refused (no implicit bypass)"
assert_eq "review" "$(yaml_get "$DIR/status.yaml" phase)" "C: phase must stay review"
assert_eq "1" "$(event_count "$DIR" completion_blocked)" "C: completion_blocked recorded"

# Force to a non-done phase is untouched by the guard.
rc=0
ruby "$FORCE" TASK-903 "$DIR/status.yaml" 2026-09-30 free-roam escalated orchestrator "loop guard" >/dev/null 2>&1 || rc=$?
assert_eq "0" "$rc" "C: forcing a non-done phase is not affected"
assert_eq "escalated" "$(yaml_get "$DIR/status.yaml" phase)" "C: non-done force still lands"

# Test F — backward compatibility: no completion_gates key, nothing changes.
DIR="$(new_task TASK-904)"
write_status "$DIR" TASK-904 review ""
write_reviewer_approved "$DIR"
rc=0
ruby "$SYNC" TASK-904 reviewer "$DIR/status.yaml" "$DIR/reviewer-output.yaml" 2026-09-30 in_review >/dev/null 2>&1 || rc=$?
assert_eq "0" "$rc" "F: a task without completion_gates syncs to done as before"
assert_eq "done" "$(yaml_get "$DIR/status.yaml" phase)" "F: phase is done"
assert_eq "0" "$(event_count "$DIR" completion_blocked)" "F: no completion_blocked event"

DIR="$(new_task TASK-905)"
write_status "$DIR" TASK-905 in_review ""
cat > "$DIR/decision.yaml" <<'YAML'
task_id: TASK-905
decisions:
  - decision: approve
    actor: alice
    decided_at: "2026-09-30T01:00:00Z"
YAML
out="$(ruby "$RECONCILE" TASK-905 2>/dev/null)"
assert_eq "applied:approve:done" "$out" "F: approve without gates still applies"
assert_eq "done" "$(yaml_get "$DIR/status.yaml" phase)" "F: approve without gates is done"

DIR="$(new_task TASK-906)"
write_status "$DIR" TASK-906 review ""
ruby "$FORCE" TASK-906 "$DIR/status.yaml" 2026-09-30 done done orchestrator "operator" >/dev/null 2>&1
assert_eq "done" "$(yaml_get "$DIR/status.yaml" phase)" "F: force done without gates still works"

# Resolved gates do not block.
DIR="$(new_task TASK-907)"
write_status "$DIR" TASK-907 review 'completion_gates:
  authenticated_runtime:
    status: na
    actor: reviewer
    reason: no runtime-facing component changed
    updated_at: "2026-09-30T00:00:00Z"'
write_reviewer_approved "$DIR"
rc=0
ruby "$SYNC" TASK-907 reviewer "$DIR/status.yaml" "$DIR/reviewer-output.yaml" 2026-09-30 in_review >/dev/null 2>&1 || rc=$?
assert_eq "0" "$rc" "resolved gates allow done"
assert_eq "done" "$(yaml_get "$DIR/status.yaml" phase)" "resolved gates -> done"
echo "[ok] writers enforce the guard (A, B, C, F)"
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bash tests/integration/completion-gates.sh
```

Expected: FAIL at `A: sync must exit 5` — the current `sync-status-from-output.rb` exits `0` and writes `done`.

- [ ] **Step 3: Wire the guard into `sync-status-from-output.rb`**

Add the require directly under the existing `require_relative "task-ownership"`:

```ruby
require_relative "completion-guard"
```

Insert this block immediately after the `new_phase = case …` expression ends and before the line `work_agents = ["dev", "dev-2", "reviewer", "debugger", "devops"]` (so nothing — not `iteration`, not `free_roam_entries` — has been mutated yet):

```ruby
# Issue #28: a declared completion gate that is unresolved blocks `done`. Refuse
# BEFORE any mutation: no phase change, no last_synced_output (so the same
# artifact is re-evaluated on the next sync), no validation_failed routing.
if new_phase == "done"
  verdict = CompletionGuard.can_transition_to_done(status)
  unless verdict.allowed
    CompletionGuard.record_blocked!(
      File.dirname(status_path),
      attempted: "#{old_phase} -> done", actor: actor_agent, unresolved: verdict.unresolved
    )
    warn CompletionGuard.blocked_message(verdict.unresolved)
    exit CompletionGuard::COMPLETION_BLOCKED
  end
end

```

In the header comment, extend the `Exit:` line: after `4 corrupt status.yaml;` add `5 completion blocked by an unresolved completion gate (issue #28, status.yaml untouched);`.

- [ ] **Step 4: Wire the guard into `force-status-route.rb`**

Add under the existing `require_relative "task-ownership"`:

```ruby
require_relative "completion-guard"
```

Insert immediately after the `old_phase = "pending" if old_phase.empty?` line and before `status["task_id"] ||= task_id`:

```ruby
# Issue #28: `force` is not a bypass. Routing to done is subject to the same
# completion guard as every other writer. If a declared gate genuinely does not
# apply, mark it `na` (with actor + reason) through scripts/update-completion-gate.rb first.
if new_phase == "done" || next_agent == "done"
  verdict = CompletionGuard.can_transition_to_done(status)
  unless verdict.allowed
    CompletionGuard.record_blocked!(
      File.dirname(status_path),
      attempted: "#{old_phase} -> done", actor: actor_agent, unresolved: verdict.unresolved
    )
    warn CompletionGuard.blocked_message(verdict.unresolved)
    exit CompletionGuard::COMPLETION_BLOCKED
  end
end

```

In the header comment, change `Exit: 0 success; 9 ownership fence refused` to `Exit: 0 success; 5 completion blocked by an unresolved completion gate (issue #28); 9 ownership fence refused`.

- [ ] **Step 5: Wire the guard into `reconcile-decision.rb`**

Add under the existing `require_relative "task-ownership"`:

```ruby
require_relative "completion-guard"
```

Replace the block

```ruby
mapping = DECISION_MAP.fetch(latest["decision"])
prev_phase = status["phase"].to_s

status["phase"] = mapping["phase"]
```

with

```ruby
mapping = DECISION_MAP.fetch(latest["decision"])
prev_phase = status["phase"].to_s

# Issue #28: human approval is permission, not completion. `approve` maps to
# `done`, so it is held while a declared completion gate is unresolved. The
# decision is NOT marked applied: it stays pending and applies automatically
# once the gates resolve (a newer decision still supersedes it).
if mapping["phase"] == "done"
  verdict = CompletionGuard.can_transition_to_done(status)
  unless verdict.allowed
    CompletionGuard.record_blocked!(
      task_dir,
      attempted: "#{prev_phase.empty? ? 'unknown' : prev_phase} -> done",
      actor: "orchestrator", unresolved: verdict.unresolved
    )
    warn CompletionGuard.blocked_message(verdict.unresolved)
    puts "blocked:#{latest['decision']}:#{verdict.unresolved.join(',')}"
    exit 0
  end
end

status["phase"] = mapping["phase"]
```

- [ ] **Step 6: Teach `run-agent.sh` the new outcomes**

(a) In the sync handling, insert a new branch between the `if [[ "$SYNC_RC" -eq 3 ]]; then … ` block and the `elif [[ "$SYNC_RC" -ne 0 ]]; then` line. The result reads:

```bash
      if [[ "$SYNC_RC" -eq 3 ]]; then
        # (existing S1 branch, unchanged)
        ...
      elif [[ "$SYNC_RC" -eq 5 ]]; then
        # Issue #28: a declared completion gate is unresolved. This is a legitimate
        # wait, not a validation defect: the task keeps its phase, no
        # validation_failed retry is consumed, and completion-guard already logged
        # the completion_blocked event in meta.yaml.
        echo "Completion blocked: the task stays in its current phase until its declared completion gates are resolved (see docs/completion-gates.md)."
      elif [[ "$SYNC_RC" -ne 0 ]]; then
        # (existing branch, unchanged)
        ...
```

(b) Directly after the existing `if [[ "$DECISION_RESULT" == applied:* ]]; then … fi` block (the one that logs `decision_applied`), add:

```bash
  if [[ "$DECISION_RESULT" == blocked:* ]]; then
    echo "Human decision (${DECISION_RESULT#blocked:}) is held: unresolved completion gates. The task keeps its current phase; the decision applies once the gates are resolved."
  fi
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
bash tests/integration/completion-gates.sh
```

Expected: `[ok] completion-guard unit checks`, `[ok] writers enforce the guard (A, B, C, F)`, `PASS: completion-gates`.

- [ ] **Step 8: Run the existing suites the writers feed**

```bash
for t in decision-reconcile state-machine-consistency concurrent-status-writes \
         idempotency-and-reentry validation-failed-bounded output-contract \
         driver-decision-e2e task-ownership; do
  if bash "tests/integration/$t.sh" >/tmp/after-$t.log 2>&1; then echo "PASS $t"; else echo "FAIL $t"; fi
done
```

Expected: every suite that passed in the Preflight baseline still passes.

- [ ] **Step 9: Commit**

```bash
git add scripts/sync-status-from-output.rb scripts/reconcile-decision.rb scripts/force-status-route.rb run-agent.sh tests/integration/completion-gates.sh
git commit -m "feat(completion-gates): bind sync, decision and force writers to the guard (#28)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The auto loop must not announce completion the guard refused

**Files:**
- Modify: `scripts/decide-next-step.rb`
- Modify: `run-agent.sh` (`decide_next_step` wrapper near line 1770; its call in the auto loop near line 2240)
- Modify: `tests/integration/completion-gates.sh`

**Interfaces:**
- Consumes: `CompletionGuard.can_transition_to_done`, `.blocked_message` (Task 1).
- Produces: `decide-next-step.rb <STEP> <OUTPUT_FILE> [STATUS_FILE]`; with a status file whose gates are unresolved and a `done` next agent it prints `next= terminal=false`. Still always exits `0`. Without the third argument the output is byte-identical to today.

- [ ] **Step 1: Append the failing tests**

Insert above the `# --- APPEND-NEW-SECTIONS-ABOVE ---` line:

```bash
# ---------------------------------------------------------------------------
# Task 3 — the auto loop must not claim completion the guard refused
# ---------------------------------------------------------------------------
DIR="$(new_task TASK-910)"
write_status "$DIR" TASK-910 review "$PENDING_GATE"
write_reviewer_approved "$DIR"
assert_eq "next=done terminal=true" "$(ruby "$DECIDE" reviewer "$DIR/reviewer-output.yaml" 2>/dev/null)" \
  "decide-next-step without a status file is unchanged"
assert_eq "next= terminal=false" "$(ruby "$DECIDE" reviewer "$DIR/reviewer-output.yaml" "$DIR/status.yaml" 2>/dev/null)" \
  "decide-next-step must not report terminal while a gate is pending"

DIR="$(new_task TASK-911)"
write_status "$DIR" TASK-911 review ""
write_reviewer_approved "$DIR"
assert_eq "next=done terminal=true" "$(ruby "$DECIDE" reviewer "$DIR/reviewer-output.yaml" "$DIR/status.yaml" 2>/dev/null)" \
  "a task without gates is still terminal on done"
echo "[ok] auto-loop decision respects the guard"
```

- [ ] **Step 2: Run to verify it fails**

```bash
bash tests/integration/completion-gates.sh
```

Expected: FAIL at `decide-next-step must not report terminal while a gate is pending` (got `next=done terminal=true`).

- [ ] **Step 3: Implement it in `decide-next-step.rb`**

Add near the top, under `require_relative "next-agent-from-output"`:

```ruby
require "yaml"
require "date"
require_relative "completion-guard"
```

Replace

```ruby
step, output_path = ARGV
if step.nil? || output_path.nil?
  warn "Usage: decide-next-step.rb <STEP> <STEP_OUTPUT_FILE>"
  exit 2
end
```

with

```ruby
step, output_path, status_path = ARGV
if step.nil? || output_path.nil?
  warn "Usage: decide-next-step.rb <STEP> <STEP_OUTPUT_FILE> [STATUS_FILE]"
  exit 2
end
```

Replace

```ruby
terminal = (next_agent == "done")

puts "next=#{next_agent} terminal=#{terminal}"
```

with

```ruby
terminal = (next_agent == "done")

# Issue #28: this decision reads only the role output, so on its own it would
# declare the task complete even when the status writer refused `done` because a
# declared completion gate is unresolved. When the caller supplies status.yaml,
# ask the same guard. Fail closed: an unreadable status is not terminal.
if terminal && status_path && File.exist?(status_path)
  begin
    status = YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true) || {}
    verdict = CompletionGuard.can_transition_to_done(status)
    unless verdict.allowed
      warn CompletionGuard.blocked_message(verdict.unresolved)
      terminal = false
      next_agent = ""
    end
  rescue StandardError => e
    warn "decide-next-step: could not read #{status_path} to check completion gates: #{e.message}"
    terminal = false
    next_agent = ""
  end
end

puts "next=#{next_agent} terminal=#{terminal}"
```

Update the header `Usage:` block to `ruby scripts/decide-next-step.rb <STEP> <STEP_OUTPUT_FILE> [STATUS_FILE]`.

- [ ] **Step 4: Pass the status file from `run-agent.sh`**

Replace the wrapper

```bash
decide_next_step() {
  local step="$1"
  local output_file="$2"

  ruby "$OFFICE_DIR/scripts/decide-next-step.rb" "$step" "$output_file"
}
```

with

```bash
decide_next_step() {
  local step="$1"
  local output_file="$2"
  local status_file="${3:-}"

  # Issue #28: the optional status file lets the decision honor unresolved
  # completion gates instead of announcing a completion the writer refused.
  ruby "$OFFICE_DIR/scripts/decide-next-step.rb" "$step" "$output_file" ${status_file:+"$status_file"}
}
```

and in the auto loop change

```bash
    DECISION_LINE="$(decide_next_step "$STEP" "$STEP_OUTPUT")"
```

to

```bash
    DECISION_LINE="$(decide_next_step "$STEP" "$STEP_OUTPUT" "$STATUS_FILE")"
```

- [ ] **Step 5: Run to verify it passes, then the auto suites**

```bash
bash tests/integration/completion-gates.sh
bash tests/integration/auto-parallel.sh && echo "PASS auto-parallel"
```

Expected: `[ok] auto-loop decision respects the guard`, `PASS: completion-gates`, and `PASS auto-parallel` (or the same result as its Preflight baseline).

- [ ] **Step 6: Commit**

```bash
git add scripts/decide-next-step.rb run-agent.sh tests/integration/completion-gates.sh
git commit -m "feat(completion-gates): stop the auto loop announcing refused completions (#28)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The governed gate writer (tests D, E, and dependency release)

**Files:**
- Create: `scripts/update-completion-gate.rb`
- Modify: `tests/integration/completion-gates.sh`

**Interfaces:**
- Consumes: `CompletionGuard::GATE_NAME_PATTERN`, `::GATE_STATUSES`, `.event_agent`, `.append_meta_event!` (Task 1); `TaskOwnership.fence!` (existing, `scripts/task-ownership.rb`).
- Produces the CLI:

```
ruby scripts/update-completion-gate.rb <TASK_ID> declare <GATE> --actor <A> [--reason <R>]
ruby scripts/update-completion-gate.rb <TASK_ID> pass    <GATE> --actor <A> --reason <R> [--evidence ev-001,ev-002]
ruby scripts/update-completion-gate.rb <TASK_ID> na      <GATE> --actor <A> --reason <R>
```

  Exit `0` ok; `2` usage / invalid transition; `3` unreadable status or unknown evidence id; `9` ownership fence refused (raised by `TaskOwnership.fence!`). On success it prints `gate <name>: <old> -> <new>`. Runs dir honors `AI_OFFICE_RUNS_DIR` like the other scripts.

  Written gate record: `{status, actor, reason (if given), updated_at, evidence_refs}` (`evidence_refs` is always an array; empty unless `pass --evidence`). Side effects: one `history` entry on `status.yaml` (`phase: "gate <name>: <old|absent> -> <new>"`) and one `completion_gate_updated` event in `meta.yaml`.

- [ ] **Step 1: Append the failing tests**

Insert above the `# --- APPEND-NEW-SECTIONS-ABOVE ---` line:

```bash
# ---------------------------------------------------------------------------
# Task 4 — the governed gate writer (D, E) and dependency release
# ---------------------------------------------------------------------------
gate() { ruby "$GATE" "$@"; }

DIR="$(new_task TASK-920)"
write_status "$DIR" TASK-920 review ""

# declare
out="$(gate TASK-920 declare authenticated_runtime --actor pm --reason "prod branch page must show API/LINE counts")"
assert_eq "gate authenticated_runtime: absent -> pending" "$out" "declare output"
assert_eq "pending" "$(yaml_get "$DIR/status.yaml" completion_gates.authenticated_runtime.status)" "declare sets pending"
assert_eq "pm" "$(yaml_get "$DIR/status.yaml" completion_gates.authenticated_runtime.actor)" "declare records the actor"
assert_eq "1" "$(event_count "$DIR" completion_gate_updated)" "declare is auditable in meta.yaml"

# declaring twice, unknown gate, bad name, missing actor, missing reason: all refused
rc=0; gate TASK-920 declare authenticated_runtime --actor pm >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "re-declaring an existing gate is refused"
rc=0; gate TASK-920 pass no_such_gate --actor dev --reason x >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "resolving an undeclared gate is refused"
rc=0; gate TASK-920 declare Bad-Name --actor pm >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "gate names must match the grammar"
rc=0; gate TASK-920 pass authenticated_runtime --reason "looks fine" >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "pass without an actor is refused"
rc=0; gate TASK-920 pass authenticated_runtime --actor dev >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "pass without a reason is refused"
rc=0; gate TASK-920 na authenticated_runtime --actor reviewer >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "na without a reason is refused"
assert_eq "pending" "$(yaml_get "$DIR/status.yaml" completion_gates.authenticated_runtime.status)" "refused edits leave the gate untouched"

# Test D — legitimate `na`: audit record exists and completion becomes possible.
out="$(gate TASK-920 na authenticated_runtime --actor reviewer --reason "no runtime-facing component changed after investigation")"
assert_eq "gate authenticated_runtime: pending -> na" "$out" "na output"
assert_eq "na" "$(yaml_get "$DIR/status.yaml" completion_gates.authenticated_runtime.status)" "D: gate is na"
assert_eq "reviewer" "$(yaml_get "$DIR/status.yaml" completion_gates.authenticated_runtime.actor)" "D: actor recorded"
assert_eq "no runtime-facing component changed after investigation" \
  "$(yaml_get "$DIR/status.yaml" completion_gates.authenticated_runtime.reason)" "D: reason recorded"
[[ -n "$(yaml_get "$DIR/status.yaml" completion_gates.authenticated_runtime.updated_at)" ]] || fail "D: updated_at recorded"
assert_eq "2" "$(event_count "$DIR" completion_gate_updated)" "D: the na change is in the execution trail (meta)"
grep -q "gate authenticated_runtime: pending -> na" "$DIR/status.yaml" || fail "D: the na change is in status history"
ruby -e 'require ARGV[0]; s = YAML.safe_load(File.read(ARGV[1])); exit(CompletionGuard.can_transition_to_done(s).allowed ? 0 : 1)' \
  "$ROOT_DIR/scripts/completion-guard" "$DIR/status.yaml" || fail "D: after na the guard must allow done"

# Test E — evidence-backed pass with an explicit acceptance judgment.
DIR="$(new_task TASK-921)"
write_status "$DIR" TASK-921 review ""
gate TASK-921 declare deployment --actor pm >/dev/null
rc=0; gate TASK-921 pass deployment --actor dev --reason "deployed" --evidence ev-001 >/dev/null 2>&1 || rc=$?
assert_eq "3" "$rc" "E: an evidence id that does not resolve is refused"
assert_eq "pending" "$(yaml_get "$DIR/status.yaml" completion_gates.deployment.status)" "E: refused pass leaves the gate pending"
( cd "$ROOT_DIR" && bash scripts/record-evidence.sh TASK-921 -- true >/dev/null 2>&1 ) || fail "E: could not record evidence for the test"
EV_ID="$(ruby -e 'require "yaml"; puts YAML.safe_load(File.read(ARGV[0]))["evidence"].last["id"]' "$DIR/evidence.yaml")"
out="$(gate TASK-921 pass deployment --actor dev --reason "ECS service reports the new image healthy" --evidence "$EV_ID")"
assert_eq "gate deployment: pending -> pass" "$out" "E: pass output"
assert_eq "pass" "$(yaml_get "$DIR/status.yaml" completion_gates.deployment.status)" "E: gate is pass"
grep -q -- "- $EV_ID" "$DIR/status.yaml" || fail "E: evidence ref $EV_ID must be stored on the gate"
assert_eq "ECS service reports the new image healthy" "$(yaml_get "$DIR/status.yaml" completion_gates.deployment.reason)" "E: acceptance reason stored"

# The helper refuses to edit gates on a finished task (no done + pending).
DIR="$(new_task TASK-922)"
write_status "$DIR" TASK-922 done ""
rc=0; gate TASK-922 declare late_gate --actor pm >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "gates cannot be declared on a done task"

# Dependency release: a pending gate upstream must keep downstream blocked; once
# the gate resolves and done lands, dependency reconciliation releases it.
UP="$(new_task TASK-930)"; DOWN="$(new_task TASK-931)"
write_status "$UP" TASK-930 review ""
gate TASK-930 declare authenticated_runtime --actor pm >/dev/null
write_reviewer_approved "$UP"
cat > "$DOWN/status.yaml" <<'YAML'
task_id: TASK-931
phase: blocked
state: blocked
iteration: 0
current_agent: pm
blocked_on:
  - TASK-930
YAML
rc=0; ruby "$SYNC" TASK-930 reviewer "$UP/status.yaml" "$UP/reviewer-output.yaml" 2026-09-30 in_review >/dev/null 2>&1 || rc=$?
assert_eq "5" "$rc" "dependency: upstream done is refused while its gate is pending"
ruby "$BLOCKED_STATUS" TASK-931 "$DOWN/status.yaml" "$TMP_RUNS" 2026-09-30 done in_review true true false >/dev/null 2>&1
assert_eq "blocked" "$(yaml_get "$DOWN/status.yaml" phase)" "dependency: downstream stays blocked while upstream is not done"

gate TASK-930 na authenticated_runtime --actor reviewer --reason "no runtime-facing change" >/dev/null
ruby "$SYNC" TASK-930 reviewer "$UP/status.yaml" "$UP/reviewer-output.yaml" 2026-09-30 in_review >/dev/null 2>&1
assert_eq "done" "$(yaml_get "$UP/status.yaml" phase)" "dependency: upstream reaches done once the gate is resolved"
ruby "$BLOCKED_STATUS" TASK-931 "$DOWN/status.yaml" "$TMP_RUNS" 2026-09-30 done in_review true true false >/dev/null 2>&1
assert_eq "blocked" "$(yaml_get "$DOWN/status.yaml" phase)" "dependency: (sanity) see next assertion"
echo "[ok] gate writer (D, E) and dependency release"
```

- [ ] **Step 2: Run to verify it fails**

```bash
bash tests/integration/completion-gates.sh
```

Expected: FAIL — `update-completion-gate.rb` does not exist (`ruby: No such file or directory`, first `gate TASK-920 declare …` call).

- [ ] **Step 3: Write the helper**

Create `scripts/update-completion-gate.rb`:

```ruby
#!/usr/bin/env ruby
# frozen_string_literal: true

# The one governed writer for completion gates (issue #28, Phase 1A).
#
# Agents and operators must not hand-edit `completion_gates` in status.yaml:
# every declaration and every resolution goes through here so it is locked,
# ownership-fenced, validated, and recorded in status history AND meta.yaml.
# This is not a general authority system. `actor` is free text; Phase 1A does
# not verify identity or independence (see docs/completion-gates.md).
#
# Usage:
#   ruby scripts/update-completion-gate.rb <TASK_ID> declare <GATE> --actor <A> [--reason <R>]
#   ruby scripts/update-completion-gate.rb <TASK_ID> pass    <GATE> --actor <A> --reason <R> [--evidence ev-001,ev-002]
#   ruby scripts/update-completion-gate.rb <TASK_ID> na      <GATE> --actor <A> --reason <R>
#
# Exit: 0 ok; 2 usage error or invalid transition; 3 unreadable status.yaml or
# an evidence id that does not resolve; 9 ownership fence refused (raised by
# TaskOwnership.fence!, see docs/task-ownership.md).

require "yaml"
require "date"
require "time"
require_relative "task-ownership"
require_relative "completion-guard"

OFFICE_DIR = File.expand_path(File.join(__dir__, ".."))
# Overridable so tests can point at a temp dir instead of the live runs/.
RUNS_DIR = ENV.fetch("AI_OFFICE_RUNS_DIR", File.join(OFFICE_DIR, "runs"))
EVIDENCE_ID_PATTERN = /\Aev-\d{3,}\z/.freeze
ACTIONS = { "declare" => "pending", "pass" => "pass", "na" => "na" }.freeze
FINISHED_PHASES = %w[done aborted].freeze

def usage!(message = nil)
  warn message if message
  warn "Usage: update-completion-gate.rb <TASK_ID> <declare|pass|na> <GATE> --actor <A> [--reason <R>] [--evidence ev-001,ev-002]"
  exit 2
end

args = ARGV.dup
task_id = args.shift
action = args.shift
gate_name = args.shift
usage! if task_id.nil? || action.nil? || gate_name.nil?
usage!("unknown action '#{action}' (expected declare, pass or na)") unless ACTIONS.key?(action)
usage!("gate name '#{gate_name}' must match #{CompletionGuard::GATE_NAME_PATTERN.inspect}") unless gate_name.match?(CompletionGuard::GATE_NAME_PATTERN)

opts = {}
until args.empty?
  flag = args.shift
  value = args.shift
  usage!("flag #{flag} needs a value") if value.nil?
  case flag
  when "--actor" then opts[:actor] = value.strip
  when "--reason" then opts[:reason] = value.strip
  when "--evidence" then opts[:evidence] = value.split(",").map(&:strip).reject(&:empty?)
  else usage!("unknown flag #{flag}")
  end
end

usage!("--actor is required") if opts[:actor].to_s.empty?
usage!("--reason is required for #{action}") if %w[pass na].include?(action) && opts[:reason].to_s.empty?
usage!("--evidence is only valid with pass") if opts.key?(:evidence) && action != "pass"
Array(opts[:evidence]).each do |ref|
  usage!("evidence id '#{ref}' must match ev-NNN") unless ref.match?(EVIDENCE_ID_PATTERN)
end

task_dir = File.join(RUNS_DIR, task_id)
status_path = File.join(task_dir, "status.yaml")
unless File.exist?(status_path)
  warn "No status.yaml for #{task_id} at #{status_path}"
  exit 3
end

# Same critical section as every other status writer: per-task lock, then the
# ownership fence inside it.
lock = File.open(File.join(task_dir, ".lock"), File::RDWR | File::CREAT, 0o644)
lock.flock(File::LOCK_EX)
TaskOwnership.fence!(task_dir)

status = begin
  YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true) || {}
rescue Psych::SyntaxError => e
  warn "status.yaml is corrupt for #{task_id}: #{e.message}"
  exit 3
end

phase = status["phase"].to_s.strip
if FINISHED_PHASES.include?(phase)
  warn "Refusing to edit completion gates: #{task_id} is #{phase}."
  exit 2
end

if status.key?("completion_gates") && !status["completion_gates"].is_a?(Hash)
  warn "status.yaml completion_gates is not a map; fix it by hand before using this helper."
  exit 3
end
gates = (status["completion_gates"] ||= {})
existing = gates[gate_name]
new_status = ACTIONS.fetch(action)

if action == "declare"
  usage!("gate '#{gate_name}' is already declared; resolve it with pass or na") unless existing.nil?
else
  usage!("gate '#{gate_name}' is not declared for #{task_id}; declare it first") unless existing.is_a?(Hash)
end

if action == "pass" && !Array(opts[:evidence]).empty?
  ledger_path = File.join(task_dir, "evidence.yaml")
  known = if File.exist?(ledger_path)
            ledger = YAML.safe_load(File.read(ledger_path), permitted_classes: [Date, Time], aliases: true)
            Array(ledger.is_a?(Hash) ? ledger["evidence"] : nil).map { |e| e["id"] if e.is_a?(Hash) }.compact
          else
            []
          end
  unknown = opts[:evidence] - known
  unless unknown.empty?
    warn "Unknown evidence id(s) for #{task_id}: #{unknown.join(', ')} (not in evidence.yaml)"
    exit 3
  end
end

old_status = existing.is_a?(Hash) ? existing["status"].to_s : "absent"
now = Time.now.utc.strftime("%FT%TZ")

record = { "status" => new_status, "actor" => opts[:actor] }
record["reason"] = opts[:reason] unless opts[:reason].to_s.empty?
record["updated_at"] = now
record["evidence_refs"] = Array(opts[:evidence])
gates[gate_name] = record

status["updated_at"] = Date.today.to_s
status["history"] = [] unless status["history"].is_a?(Array)
status["history"] << {
  "phase" => "gate #{gate_name}: #{old_status} -> #{new_status}",
  "agent" => CompletionGuard.event_agent(opts[:actor]),
  "reason" => opts[:reason].to_s.empty? ? "completion gate declared" : opts[:reason],
  "at" => now
}

tmp_path = "#{status_path}.tmp.#{$$}"
begin
  File.write(tmp_path, YAML.dump(status))
  File.rename(tmp_path, status_path)
rescue StandardError => e
  File.delete(tmp_path) if File.exist?(tmp_path)
  raise e
end

CompletionGuard.append_meta_event!(
  task_dir,
  type: "completion_gate_updated",
  agent: CompletionGuard.event_agent(opts[:actor]),
  details: "gate=#{gate_name} #{old_status}->#{new_status} actor=#{opts[:actor]}"
)

puts "gate #{gate_name}: #{old_status} -> #{new_status}"
```

- [ ] **Step 4: Run to verify it passes**

```bash
bash tests/integration/completion-gates.sh
```

Expected: `[ok] gate writer (D, E) and dependency release` and `PASS: completion-gates`.

- [ ] **Step 5: Tighten the dependency test's placeholder assertion**

The last dependency assertion in Step 1 was written as a sanity check before the outcome was known. The upstream is now `done`, so `reconcile-blocked-status.rb` should release the downstream task. Replace this final assertion of the dependency block

```bash
assert_eq "blocked" "$(yaml_get "$DOWN/status.yaml" phase)" "dependency: (sanity) see next assertion"
```

with

```bash
[[ "$(yaml_get "$DOWN/status.yaml" phase)" != "blocked" ]] || fail "dependency: downstream must be released once the upstream reaches done"
```

Run `bash tests/integration/completion-gates.sh` again.

Expected: `PASS: completion-gates`. If the released phase is something other than `blocked` the assertion holds; if the script keeps the task blocked, read the stdout of `reconcile-blocked-status.rb` (drop the `>/dev/null`) before changing anything — the argument order is `TASK_ID STATUS_FILE RUNS_DIR TODAY UNBLOCK_PHASE REVIEWER_QUEUE_PHASE CLEAR_WAITING_FOR SET_READY ROUTE_FROM_ASSIGNMENT`.

- [ ] **Step 6: Commit**

```bash
git add scripts/update-completion-gate.rb tests/integration/completion-gates.sh
git commit -m "feat(completion-gates): add governed gate writer (#28)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Stored-state validation, schema and parity (test G)

**Files:**
- Modify: `validate-yaml.rb` (require near line 6; new `validate_completion_gates` and `validate_completion_gate_evidence` next to `validate_status`; call sites in `validate_status` and `validate_task_dir`)
- Modify: `schemas/status.schema.yaml`
- Modify: `tests/integration/schema-validator-parity.sh`
- Modify: `tests/integration/completion-gates.sh`

**Interfaces:**
- Consumes: `CompletionGuard::GATE_STATUSES`, `::GATE_NAME_PATTERN`, `.can_transition_to_done` (Task 1); the validator's existing `expect_enum`, `expect_string_array`-style helpers, `validate_evidence_ref_shape`, `validate_evidence_refs_resolve`, `EVIDENCE_ID_HINT`.
- Produces: `validate-yaml.rb` errors for (a) malformed `completion_gates`, (b) `pass`/`na` missing `actor`/`reason`/`updated_at`, (c) `phase`/`state: done` with an unresolved gate, (d) `evidence_refs` that do not resolve.

- [ ] **Step 1: Append the failing tests**

Insert above the `# --- APPEND-NEW-SECTIONS-ABOVE ---` line:

```bash
# ---------------------------------------------------------------------------
# Task 5 — stored-state validation (G) and shape rules
# ---------------------------------------------------------------------------
expect_valid()   { ruby "$VALIDATOR" "$1" >/dev/null 2>&1 || fail "$2 (validation unexpectedly failed)"; }
expect_invalid() {  # <task_dir> <message> <substring the errors must mention>
  local out
  out="$(ruby "$VALIDATOR" "$1" 2>&1)" && fail "$2 (validation unexpectedly passed)"
  grep -q "$3" <<<"$out" || fail "$2 (expected the errors to mention '$3', got: $out)"
}

# Test G — a manually corrupted stored state: done + a pending gate.
DIR="$(new_task TASK-940)"
write_status "$DIR" TASK-940 done "$PENDING_GATE"
expect_invalid "$DIR" "G: done with a pending gate must fail validation" "unresolved completion gate"

# Same task in review is fine.
write_status "$DIR" TASK-940 review "$PENDING_GATE"
expect_valid "$DIR" "a pending gate is valid while the task is not done"

# Backward compatibility: no completion_gates key.
write_status "$DIR" TASK-940 done ""
expect_valid "$DIR" "F: a done task without gates still validates"

# Resolved gates on a done task validate.
write_status "$DIR" TASK-940 done 'completion_gates:
  authenticated_runtime:
    status: na
    actor: reviewer
    reason: no runtime-facing component changed
    updated_at: "2026-09-30T00:00:00Z"
    evidence_refs: []'
expect_valid "$DIR" "done with all gates resolved validates"

# Shape rules.
write_status "$DIR" TASK-940 review 'completion_gates:
  authenticated_runtime:
    status: pass'
expect_invalid "$DIR" "pass without actor/reason/updated_at is invalid" "actor"

write_status "$DIR" TASK-940 review 'completion_gates:
  authenticated_runtime:
    status: passed'
expect_invalid "$DIR" "an unknown gate status is invalid" "status"

write_status "$DIR" TASK-940 review 'completion_gates:
  Bad-Name:
    status: pending'
expect_invalid "$DIR" "a bad gate name is invalid" "gate name"

write_status "$DIR" TASK-940 review 'completion_gates:
  - authenticated_runtime'
expect_invalid "$DIR" "completion_gates must be a map" "completion_gates"

write_status "$DIR" TASK-940 review 'completion_gates:
  deployment:
    status: pass
    actor: dev
    reason: deployed
    updated_at: "2026-09-30T00:00:00Z"
    evidence_refs:
      - ev-099'
expect_invalid "$DIR" "a pass gate citing evidence that does not exist is invalid" "evidence"
echo "[ok] stored-state validation (G) and shape rules"
```

- [ ] **Step 2: Run to verify it fails**

```bash
bash tests/integration/completion-gates.sh
```

Expected: FAIL at `G: done with a pending gate must fail validation (validation unexpectedly passed)` — the validator does not know `completion_gates` yet.

- [ ] **Step 3: Implement the validator rules**

In `validate-yaml.rb`, add next to the existing `require_relative "scripts/review-gate"`:

```ruby
require_relative "scripts/completion-guard"
```

Add these two functions directly above `def validate_status(data, label, errors)`:

```ruby
# Completion gates (issue #28, Phase 1A). Structural rules only: the validator
# checks shape, audit metadata and that cited evidence ids resolve. It does NOT
# judge whether evidence proves acceptance — that judgment is the recorded
# `reason` by the actor that marked the gate pass/na.
def validate_completion_gates(data, label, errors)
  if data.key?("completion_gates")
    gates = data["completion_gates"]
    if gates.is_a?(Hash)
      gates.each do |name, gate|
        glabel = "#{label}.completion_gates.#{name}"
        unless name.to_s.match?(CompletionGuard::GATE_NAME_PATTERN)
          errors << "#{glabel}: gate name must match #{CompletionGuard::GATE_NAME_PATTERN.inspect}"
        end
        unless gate.is_a?(Hash)
          errors << "#{glabel} must be a map"
          next
        end
        expect_enum(gate["status"], CompletionGuard::GATE_STATUSES, "#{glabel}.status", errors)
        if CompletionGuard::RESOLVED_STATUSES.include?(gate["status"])
          %w[actor reason updated_at].each do |key|
            unless gate[key].is_a?(String) && !gate[key].strip.empty?
              errors << "#{glabel}.#{key} is required (non-empty) when status is #{gate['status']}"
            end
          end
        end
        validate_evidence_ref_shape(gate["evidence_refs"], "#{glabel}.evidence_refs", errors) if gate.key?("evidence_refs")
      end
    else
      errors << "#{label}.completion_gates must be a map of gate name -> gate record"
    end
  end

  # Defense in depth for the transition guard: an already-stored impossible
  # state (done while a declared gate is unresolved) is a validation error.
  if [data["phase"], data["state"]].include?("done")
    verdict = CompletionGuard.can_transition_to_done(data)
    unless verdict.allowed
      errors << "#{label}: phase/state 'done' with unresolved completion gate(s): #{verdict.unresolved.join(', ')} " \
                "(resolve each gate to pass or na through scripts/update-completion-gate.rb)"
    end
  end
end

# Every evidence id cited by a gate must resolve in THIS task's evidence.yaml,
# exactly like evidence_refs on role outputs (reuses that resolver).
def validate_completion_gate_evidence(status, task_dir, errors)
  return unless status.is_a?(Hash) && status["completion_gates"].is_a?(Hash)

  refs = status["completion_gates"].values.flat_map do |gate|
    gate.is_a?(Hash) ? Array(gate["evidence_refs"]).select { |ref| ref.is_a?(String) } : []
  end
  return if refs.empty?

  validate_evidence_refs_resolve({ "evidence_refs" => refs.uniq }, "status.yaml.completion_gates", task_dir, errors)
end

```

In `validate_status`, add this line directly after the existing `expect_string_array(data["waiting_for"], "#{label}.waiting_for", errors) if data.key?("waiting_for")`:

```ruby
  validate_completion_gates(data, label, errors)
```

(It must be before the `return unless data.key?("assignment")` early return further down.)

In `validate_task_dir`, replace

```ruby
  if File.exist?(status_file)
    validate_status(load_yaml(status_file), "status.yaml", errors)
  else
```

with

```ruby
  if File.exist?(status_file)
    status_data = load_yaml(status_file)
    validate_status(status_data, "status.yaml", errors)
    validate_completion_gate_evidence(status_data, task_dir, errors)
  else
```

- [ ] **Step 4: Document the field in the schema**

In `schemas/status.schema.yaml`, add this property under `properties:` directly after the `waiting_for:` property (before `handoff:`):

```yaml
  completion_gates:
    type: object
    description: >
      Optional (issue #28, Phase 1A). Declared completion gates. A gate that is
      present is required: the task cannot transition to `done` while any gate
      is `pending`. `pass` and `na` require actor, reason and updated_at.
      `evidence_refs` are optional; when present each id must resolve in the
      task's evidence.yaml. Written only through scripts/update-completion-gate.rb.
      Phase 1A does not verify actor identity or independence.
    propertyNames:
      pattern: "^[a-z][a-z0-9_]*$"
    additionalProperties:
      type: object
      required:
        - status
      properties:
        status:
          type: string
          enum:
            - pending
            - pass
            - na
        actor:
          type: string
        reason:
          type: string
        updated_at:
          type: string
        evidence_refs:
          type: array
          items:
            type: string
            pattern: "^ev-[0-9]{3,}$"
```

- [ ] **Step 5: Pin the enum in the parity test**

In `tests/integration/schema-validator-parity.sh`, the embedded Ruby reads `validate-yaml.rb` as text, but `GATE_STATUSES` lives in `scripts/completion-guard.rb` and is referenced by the validator. Add a require near the top of the Ruby block (after `require "yaml"`):

```ruby
require File.join(Dir.pwd, "scripts", "completion-guard")
```

and add this row to the `checks = [ … ]` array (next to the `status.phase` / `status.state` rows):

```ruby
  ["status.completion_gates.status", CompletionGuard::GATE_STATUSES.sort,
   schema_enum("schemas/status.schema.yaml", "properties", "completion_gates", "additionalProperties", "properties", "status", "enum")],
  ["status.completion_gates.name grammar", ["a", "authenticated_runtime", "Bad", "1a", "a-b", ""].map { |s| CompletionGuard::GATE_NAME_PATTERN.match?(s) },
   ["a", "authenticated_runtime", "Bad", "1a", "a-b", ""].map { |s| Regexp.new(pattern_at("schemas/status.schema.yaml", "properties", "completion_gates", "propertyNames", "pattern")).match?(s) }],
```

- [ ] **Step 6: Run to verify everything passes**

```bash
bash tests/integration/completion-gates.sh
bash tests/integration/schema-validator-parity.sh
bash tests/integration/evidence-contract.sh
```

Expected: `PASS: completion-gates`, and the parity and evidence suites pass as in the baseline. If the parity suite fails on the new grammar row, print both arrays and fix the schema `pattern` (the schema is documentation; the validator constant is the runtime truth).

- [ ] **Step 7: Validate every real run still passes**

Existing tasks carry no `completion_gates`, so nothing may change. Spot-check the runs this issue is about:

```bash
for t in TASK-VS-003 TASK-VS-004 TASK-VS-006 TASK-VS-008 TASK-VS-010; do
  ruby validate-yaml.rb "$t" >/dev/null 2>&1 && echo "OK   $t" || echo "FAIL $t"
done
```

Expected: identical results to running the same loop on `main` before this change (use `git stash` or a second checkout if you need the comparison). A newly failing run means the validator changed behavior for tasks without gates — stop and fix.

- [ ] **Step 8: Commit**

```bash
git add validate-yaml.rb schemas/status.schema.yaml tests/integration/schema-validator-parity.sh tests/integration/completion-gates.sh
git commit -m "feat(completion-gates): validate stored state, schema and parity (#28)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Documentation

**Files:**
- Create: `docs/completion-gates.md`
- Modify: `docs/task-transition-contract.md`

- [ ] **Step 1: Write `docs/completion-gates.md`**

```markdown
# Completion Gates (Phase 1A)

Issue: vestearth/AI-office-agency#28. Opt-in, in `status.yaml` only.

## Guarantee

> Declared completion gates are enforced before `done`. Every resolution to
> `pass` or `na` is explicit and auditable with actor, reason, timestamp, and
> supporting evidence where applicable. Phase 1A does not guarantee that the
> acceptance judgment was made by an actor independent of the implementer.

## What it does not guarantee

Phase 1A does **not** provide independent verification, separation of duties,
authenticated actor identity, role-based authorization for who may resolve a
gate, or automatic discovery of the gates a task should have. A gate marked
`pass` by the same agent that implemented the work is structurally valid. That
is intentional for this slice; independent attestation belongs with the later
authorization/policy work and needs evidence that it is required.

## Shape

```yaml
completion_gates:
  authenticated_runtime:
    status: pending          # pending | pass | na
    actor: reviewer          # required for pass / na (free text, not verified)
    reason: authenticated production response contains the expected month.api and month.line values
    updated_at: "2026-09-30T00:00:00Z"
    evidence_refs:           # optional; each id must resolve in evidence.yaml
      - ev-012
```

- A gate that is present is **required**. There is no `required:` flag.
- `pending` blocks `done`. `pass` means the actor recorded an acceptance
  judgment. `na` means the gate was explicitly judged not applicable, with a
  reason. There is no `failed` / `waived` / `skipped`: a failed acceptance check
  leaves the gate `pending` and goes through the normal workflow.
- `evidence_refs` are support, not proof. The validator only checks that the ids
  resolve; the judgment is the recorded `reason`. Where acceptance is a human
  observation, record it in `reason` — there is no `human_attestation` evidence
  type.
- Removing a requirement must be explicit: resolve the gate to `na` with actor
  and reason. Do not delete the key.

## Who writes gates

Only `scripts/update-completion-gate.rb`:

```bash
ruby scripts/update-completion-gate.rb <TASK_ID> declare <GATE> --actor <A> [--reason <R>]
ruby scripts/update-completion-gate.rb <TASK_ID> pass    <GATE> --actor <A> --reason <R> [--evidence ev-001]
ruby scripts/update-completion-gate.rb <TASK_ID> na      <GATE> --actor <A> --reason <R>
```

It takes the task lock and the ownership fence, refuses to edit a `done` or
`aborted` task, appends a `status.yaml` history entry, and records a
`completion_gate_updated` event in `meta.yaml`. Gates originate from the
task's planning side (PM/operator declares them); the Office does not derive
them.

## Enforcement

`scripts/completion-guard.rb` (`CompletionGuard.can_transition_to_done`) is the
single implementation. It is called by every path that can produce `done`:

| Path | On refusal |
|---|---|
| `scripts/sync-status-from-output.rb` (reviewer `approved`) | exit `5`, status untouched |
| `scripts/reconcile-decision.rb` (human `approve`) | prints `blocked:approve:<gates>`, exit `0`, decision stays pending and applies once gates resolve |
| `scripts/force-status-route.rb ... done` | exit `5`, no implicit bypass |
| `scripts/decide-next-step.rb` (auto loop, when given the status file) | `terminal=false`, the loop does not announce completion |
| `validate-yaml.rb` (stored state) | error: `done` with an unresolved gate |

A refusal keeps the current phase, does not route to `validation_failed`, does
not consume `validation_failed_retries`, and records a `completion_blocked`
event in `meta.yaml` (identical repeats are not re-logged).

Because dependent tasks unblock when their upstream reaches `done`
(`dependency_policy.unblock_when_upstream_phase`), the guard also prevents a
false `done` from releasing downstream work.

## Compatibility

A task with no `completion_gates` key behaves exactly as before.
```

- [ ] **Step 2: Refresh `docs/task-transition-contract.md`**

Replace the whole of coupling point #1 — the numbered item that begins `1. **The transition functions are not standalone.**` and ends `…exactly what Phase 2's extraction would need to resolve (see the recommendation in \`docs/orchestration-boundary.md\` §6).` — with:

```markdown
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
```

Then, in the section "What `status.yaml` must contain…", replace the sentence beginning `**Clarification on "next_action":**` through the end of that paragraph with:

```markdown
**Clarification on "next_action":** `next_action` is required on the *role
output* file (`<role>-output.yaml`), where it drives the transition. Real
`status.yaml` files also carry a `next_action` (plus `assigned_to` and
`assignment.workstream`) that the driver does not read and the validator does
not check; `schemas/status.schema.yaml` does not list them. Treat them as
human-facing notes, not contract fields.
```

And add this subsection immediately after the "Not required but load-bearing" list:

```markdown
- `completion_gates` (issue #28, optional) — declared gates that must all be
  `pass` or `na` before any writer may set `done`. See
  [`docs/completion-gates.md`](completion-gates.md). The guard is checked by
  `sync-status-from-output.rb`, `reconcile-decision.rb`,
  `force-status-route.rb` and `decide-next-step.rb`, and re-checked by
  `validate-yaml.rb` on stored state.
```

- [ ] **Step 3: Sanity-check the docs against reality**

```bash
grep -n "completion-guard\|update-completion-gate\|COMPLETION_BLOCKED" docs/completion-gates.md docs/task-transition-contract.md
ls scripts/completion-guard.rb scripts/update-completion-gate.rb scripts/decide-next-step.rb scripts/reconcile-decision.rb scripts/force-status-route.rb scripts/sync-status-from-output.rb
```

Expected: every file the docs name exists.

- [ ] **Step 4: Commit**

```bash
git add docs/completion-gates.md docs/task-transition-contract.md
git commit -m "docs(completion-gates): document the Phase 1A contract and its limits (#28)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Full verification (no new code)

**Files:** none.

- [ ] **Step 1: Run the new suite and every suite from the Preflight baseline**

```bash
bash tests/integration/completion-gates.sh
for t in schema-validator-parity decision-reconcile state-machine-consistency \
         concurrent-status-writes idempotency-and-reentry validation-failed-bounded \
         output-contract dependency-policy dependency-guard evidence-contract \
         auto-parallel task-ownership driver-decision-e2e; do
  if bash "tests/integration/$t.sh" >/tmp/final-$t.log 2>&1; then echo "PASS $t"; else echo "FAIL $t"; fi
done
```

Expected: `PASS: completion-gates`, and every other suite matches its Preflight result. Any suite that flipped from PASS to FAIL is a regression: read `/tmp/final-<suite>.log`, fix, and re-run before continuing.

- [ ] **Step 2: Prove the tests would have caught the defect**

Test integrity: show the new tests fail without the fix. Temporarily disable the guard in `sync-status-from-output.rb` and confirm test A fails, then restore it:

```bash
cp scripts/sync-status-from-output.rb /tmp/sync.bak
sed -i.orig 's/if new_phase == "done"$/if false \&\& new_phase == "done"/' scripts/sync-status-from-output.rb
bash tests/integration/completion-gates.sh; echo "exit=$?"
mv /tmp/sync.bak scripts/sync-status-from-output.rb && rm -f scripts/sync-status-from-output.rb.orig
git diff --stat scripts/sync-status-from-output.rb
```

Expected: the run prints `[FAIL] A: sync must exit 5 (completion blocked)` with `exit=1`, and the final `git diff --stat` shows the file identical to the committed version (no output). Do not skip the restore.

- [ ] **Step 3: Replay the issue's acceptance list against real state**

Use a scratch copy, not the live `runs/`:

```bash
export AI_OFFICE_RUNS_DIR="$(mktemp -d)"
mkdir -p "$AI_OFFICE_RUNS_DIR/TASK-VS-008"
cp runs/TASK-VS-008/status.yaml "$AI_OFFICE_RUNS_DIR/TASK-VS-008/status.yaml"
ruby scripts/update-completion-gate.rb TASK-VS-008 declare authenticated_runtime --actor pm --reason "authenticated prod GET /v1/branches/{id}/overview must show month.api and month.line"
printf 'review_verdict: approved\nnext_action:\n  agent: done\n  reason: approved\n' > "$AI_OFFICE_RUNS_DIR/TASK-VS-008/reviewer-output.yaml"
ruby scripts/sync-status-from-output.rb TASK-VS-008 reviewer "$AI_OFFICE_RUNS_DIR/TASK-VS-008/status.yaml" "$AI_OFFICE_RUNS_DIR/TASK-VS-008/reviewer-output.yaml" 2026-09-30 in_review; echo "rc=$?"
ruby validate-yaml.rb "$AI_OFFICE_RUNS_DIR/TASK-VS-008"; echo "validate rc=$?"
unset AI_OFFICE_RUNS_DIR
git status --short runs/TASK-VS-008
```

Expected: `rc=5`, the message names `authenticated_runtime`, `validate rc=0` (a pending gate on a `review` task is valid), and `git status --short runs/TASK-VS-008` prints nothing (the live run was not touched). This is the VS-008 positive-enforcement case from the issue's acceptance list.

- [ ] **Step 4: Leave the branch unmerged and unpushed**

```bash
git status --short
git log --oneline -8
```

Expected: a clean tree on `feat/issue-28-completion-gates` with the six commits from Tasks 1–6. Do not push or open a PR without being asked; report the results to the operator and post a status comment on issue #28 only when they approve it.

---

## Self-Review

**1. Spec coverage** (freeze items → tasks):

| Freeze item | Task |
|---|---|
| 1 gate presence = required | Task 1 (guard), Global Constraints, Task 6 doc |
| 2 no silent removal; `na` explicit + audited | Task 4 (`na` requires actor/reason, history + meta), Task 5 (validator requires the fields) |
| 3 three states only | Task 1 (`GATE_STATUSES`), Task 5 (schema enum + parity) |
| 4 `pass` is a judgment, validator structural only | Task 4/5 (`reason` required; evidence ids resolve; no semantic check) |
| 5 no new evidence type | Global Constraints; nothing in the plan adds one |
| 6 one governed helper | Task 4 |
| 7 shared guard on every `done` path | Tasks 1–3, 5 (sync, reconcile, force, plus decide-next-step, plus validator) |
| 8 refusal keeps state, no `validation_failed`, `completion_blocked` event | Task 2 (tests A/B/C assert phase, no retry counter, event) |
| 9 `force` not a bypass | Task 2 (test C) |
| 10 ownership of the gate set (planning side, auditable) | Task 4 (`declare` via helper), Task 6 doc |
| 11 dependency release coverage | Task 4 (dependency block) |
| 12 docs + schema + validator + parity + writers together | Tasks 5, 6 |
| Tests A–G | A/B/C/F: Task 2; D/E: Task 4; G: Task 5; simple-task compatibility: Tasks 2 and 5 |
| Known limitation wording | Task 6 (guarantee quoted verbatim) |

Gap noted: the freeze says the gate set "originates from the task workflow/planning side". This plan implements that as "PM/operator runs `declare`" and does **not** change `pm-output.yaml` or the PM prompt to declare gates automatically — that would be automatic gate declaration, which the freeze defers. If the operator wants PM outputs to carry a `completion_gates` proposal, that is a separate slice.

**2. Placeholder scan:** every code step shows the code; no "TBD/handle edge cases/similar to Task N". One deliberate two-step in Task 4 (Step 1 writes a sanity assertion, Step 5 tightens it) exists because the released phase of `reconcile-blocked-status.rb` depends on `--route-from-assignment` behavior the implementer should observe; Step 5 states the concrete replacement.

**3. Type consistency:** `CompletionGuard.can_transition_to_done` → `Verdict(allowed, unresolved)` is used identically in Tasks 2, 3, 5. `record_blocked!(task_dir, attempted:, actor:, unresolved:)` and `append_meta_event!(task_dir, type:, agent:, details:, dedupe:)` signatures match between Task 1's definition and Tasks 2/4's calls. `COMPLETION_BLOCKED` is `5` everywhere. The helper's stdout format `gate <name>: <old> -> <new>` matches the test assertions and the history `phase` string.

**Known risks the implementer should watch:**
- `validate-yaml.rb`'s `load_yaml` uses `permitted_classes: []`, so an unquoted timestamp in `status.yaml` raises. `update-completion-gate.rb` writes `updated_at` as a String (Psych quotes it), and the tests quote it. Hand-written gates must quote timestamps too — worth a line in the operator doc if it bites.
- `tests/integration/completion-gates.sh` depends on `scripts/record-evidence.sh` (test E) running from the repo root; if it needs a git origin, run the suite from a normal checkout.
- The dependency test relies on `reconcile-blocked-status.rb`'s argument order; that order is copied from its `Usage:` line.

---

## Execution notes (added after the work merged as PR #29, squash `a1f1e71f`)

This plan was executed task by task and then amended by review. Where the merged code differs from the text above, the merged code wins. Known differences:

- **Task 4, dependency test:** Step 1 wrote a placeholder assertion (`(sanity) see next assertion`) that would fail, and passed `ROUTE_FROM_ASSIGNMENT=false` to `reconcile-blocked-status.rb`, which never changes phase. As merged, the final assertion is written directly (`phase != "blocked"` after release) and the argument is `true`.
- **Task 2, sync guard condition:** the plan guards only `new_phase == "done"`. As merged it also guards `next_agent == "done"` for any actor except `free-roam`, because a devops output with `next_action.agent: done` otherwise set `current_agent: done` without consulting the guard.
- **Task 2, held human approve:** on a task that declares `completion_gates`, an `approve` carrying an `against_phase` that no longer matches the current phase is recorded as superseded (`stale:approve:<against>-><current>`) instead of applying later. Without `against_phase` it still applies once the gates resolve (known limit).
- **`CompletionGuard.resolved?`:** the plan resolves a gate on `status` alone. As merged a `pass`/`na` gate must also carry non-empty String `actor`, `reason` and `updated_at` (`CompletionGuard::RESOLUTION_METADATA_KEYS`, shared with `validate-yaml.rb`), and `schemas/status.schema.yaml` encodes it with an `if/then`. `schemas/meta.schema.yaml` also gained `orchestrator` in `events[].agent`.
- **Dedupe:** `append_meta_event!` de-duplicates on agent as well as type and details.
- **Docs:** `docs/orchestration-boundary.md` had the same stale "heredoc" claim as `docs/task-transition-contract.md` and was corrected too.
- **Environment:** macOS has no `timeout` command; the baseline loop in the Preflight step must not use it.

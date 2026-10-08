# Phase 2A Plan Revision Record Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a task record a change of plan or scope as an append-only `revisions` entry in `status.yaml`, through one governed writer that, in the same write, either declares the completion gates and branches the change implies or records why it implies none.

**Architecture:** Gate and branch record construction move out of the two existing writers into `CompletionGuard`, byte-for-byte (Task 1). A new library `scripts/plan-revisions.rb` owns the revision entry: id arithmetic, the entry the writer appends, and the stored-state rules the validator enforces (Task 2). A new writer `scripts/revise-task-plan.rb` checks everything under the task lock and the ownership fence before it changes anything, then does one temp-file-and-rename write (Task 3). Docs and the full regression come last (Task 4). Enforcement comes only from the guards that already exist: a declared gate or branch blocks `done` exactly as if it had been declared by hand.

**Tech Stack:** Ruby 2.6.10 stdlib (YAML/Psych, no gems), bash integration tests.

**Spec:** [`docs/superpowers/specs/2026-10-02-plan-revisions-design.md`](../specs/2026-10-02-plan-revisions-design.md), including the 2026-10-08 review rulings (PR #39). Read it before any task. This plan argues from it.

## Global Constraints

- Ruby is 2.6.10: no endless method definitions, no `Hash#except`, no pattern matching, no numbered block params.
- Never put backticks inside double-quoted bash strings in tests (they execute).
- `kind` enum, exactly: `scope_expanded scope_narrowed plan_changed acceptance_changed`.
- Revision id: `rev-NNN`, three digits minimum, growing past 999. Compared and ordered by numeric suffix, never as strings. Next id = max + 1, computed under the task lock.
- `at`: UTC `YYYY-MM-DDTHH:MM:SSZ` (`AuthorizationLedger::TIMESTAMP_PATTERN`). One clock read per write, through `AuthorizationLedger.now_utc`, so the `AI_OFFICE_NOW` test hook behaves the same way it does in the gate writer.
- Each entry carries exactly one of `effects` (`gates_declared` + `branches_declared`, both always written, at least one non-empty) or `no_new_gates` (a non-empty string).
- Writer exits: `0` recorded, or the identical last revision is already recorded; `2` usage error or refused revision; `3` unreadable or malformed `status.yaml` / `revisions` / `completion_gates` / `branches`; `9` ownership fence (raised by `TaskOwnership.fence!`).
- Any refusal writes nothing: `status.yaml` stays byte-identical and `meta.yaml` is not touched.
- The existing writers' output is unchanged byte for byte. The Task 1 golden pins this; never edit the golden to make a run pass.
- `plan_revised` is **not** added to `ExecutionBudget::ROUTINE_META_EVENT_TYPES` (spec Design 2).
- No change to `CompletionGuard`'s `done` rules, to `office.config.yaml`, or to the 1B.2 dispatch check.
- Every new test is seen failing before its implementation. Never weaken, skip or delete an existing test.
- Commits end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push; the conductor pushes.
- Work only in the implementation worktree `/Users/earth/Documents/GitHub/ai-dev-office/.claude/worktrees/issue-28-2a-impl` (branch `feat/issue-28-2a-plan-revisions`, cut from `origin/main` after the spec PR #39 merges). Use absolute paths. Never touch the main checkout: another session owns it.

## Decisions taken while proving this plan (raise them in the PR; none changes the design)

1. **Shared helpers live in `CompletionGuard`**, not in the new library. Both existing writers already require `completion-guard.rb`, and it already owns the gate/branch names, states and `event_agent`. `plan-revisions.rb` holds only revision-specific code. This settles the spec's "shared helper (name decided in the plan)".
2. **Idempotency also compares gate bindings.** The stored entry records gate *names* only. A retry is a no-op only if the last entry has the same content **and** each named gate's current `requires_authorization` equals the requested one (`--gate g` vs `--gate g:production_backfill`). Otherwise the call proceeds and is refused because the gate already exists (exit 2), so a binding change is never swallowed as "already recorded".
3. **The branch-phase refusal is subsumed.** `BranchProjection::UPDATABLE_PHASES` is every phase except `done` and `aborted` (pinned by the parity suite), so the spec's "phase outside `UPDATABLE_PHASES` when branches are declared" can only fire for a finished task, which is already refused. The writer keeps the explicit check anyway, in case that set ever narrows.
4. **The stored-branch checks run only when they matter.** The 1C writer checks the stored branches and the `waiting_for`/`blocked_on` shapes on every call. The revision writer runs the same check (`CompletionGuard.branch_state_error`) only when the revision declares a branch or the task already has `branches`. A `--no-new-gates` revision on a task with an unrelated legacy `waiting_for` quirk is therefore not refused.
5. **Rollback test.** Running the pre-slice validator inside the suite would mean checking out old code next to new code, which is fragile. What a revert must preserve is that the gates and branches a revision declared keep protecting `done` once the `revisions` key is gone. The suite pins that directly, by stripping `revisions` and asserting that validation passes and `done` is still refused. That the pre-slice validator tolerates the key was checked by hand on 2026-10-08 and is recorded in the spec.
6. **Meta details are read, not grepped.** `YAML.dump` folds a long `details` string across lines in `meta.yaml`, so the suite reads the last `plan_revised` event with Ruby (`last_revised`). Found while proving the plan.
7. **Proof.** On 2026-10-08 every code block in this plan was applied, task by task, to a scratch worktree at main 2f3ecfe2. Each "verify it fails" step failed as written, and each "passes" step passed. The byte pin passed on unmodified code and after the refactor. The three Task 3 Step 5 mutations were each caught. `plan-revisions`, `completion-gates`, `partial-branches`, `authorization-ledger`, `failure-recovery` and `schema-validator-parity` passed, and the five `TASK-VS-*` runs validated.
8. **Branch writer clock.** `update-task-branch.rb` reads `Time.now` and ignores `AI_OFFICE_NOW`. The goldens therefore normalise every timestamp. The revision writer stamps everything with its single `now_utc` read.

## Review Focus

1. A waiting text that itself contains colons (`--branch "wave_2:blocked:operator: fairness policy A/B/C"`) must be kept whole. → Task 3, section R.
2. A gate that a revision declared but someone later removed by hand: the validator must flag it, and the writer must refuse to build on that state (exit 3) rather than append to it. → Task 2 (validator) and Task 3, section I.
3. Repeating a revision with a different binding for the same gate must not be reported as "already recorded". → Task 3, section I.
4. Ids that differ only in zero padding (`rev-001` and `rev-0001`) are the same number, so they must be rejected as non-increasing. Meanwhile `rev-999` followed by `rev-1000` must validate, even though `"rev-1000" < "rev-999"` as strings. → Task 2, section V.
5. A revision whose only declared branch is blocked, on a task with no other ready branch, must move the task to `blocked` exactly as the 1C writer would, and the history row must show `assigned -> blocked`. → Task 3, section R.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `scripts/completion-guard.rb` | + `gate_record`, `gate_history_row`, `branch_record`, `branch_history_row`, `branch_state_error` | 1 |
| `scripts/update-completion-gate.rb` | Builds its record and history row through the helpers; behaviour unchanged | 1 |
| `scripts/update-task-branch.rb` | Same, plus `branch_state_error`; behaviour unchanged | 1 |
| `scripts/plan-revisions.rb` | New. `KINDS`, `ID_PATTERN`, `id_number`, `format_id`, `next_id`, `content`, `build_entry`, `same_content?`, `stored_errors` | 2 |
| `validate-yaml.rb` | Requires `plan-revisions`; `validate_status` adds `PlanRevisions.stored_errors` | 2 |
| `schemas/status.schema.yaml` | + `revisions` property | 2 |
| `tests/integration/schema-validator-parity.sh` | Pins the `kind` enum, id grammar and `at` grammar | 2 |
| `scripts/revise-task-plan.rb` | New governed writer | 3 |
| `tests/integration/plan-revisions.sh` | New suite. Sections W (T1), V (T2), R/X/I/C/G/S (T3) | 1–3 |
| `docs/plan-revisions.md` | New: the record, the writer, the limits | 4 |
| `docs/task-transition-contract.md` | + one `revisions` bullet | 4 |

The suite is one file built in sections. **Every task inserts its sections immediately before the final line** `echo "[PASS] plan-revisions: plan revision record (#28 Phase 2A)"`. Run it with `bash /Users/earth/Documents/GitHub/ai-dev-office/.claude/worktrees/issue-28-2a-impl/tests/integration/plan-revisions.sh`. It takes well under a minute.

---

### Task 1: Shared gate/branch record construction, existing writers pinned byte for byte

**Files:**
- Modify: `scripts/completion-guard.rb` (add after `def event_agent`, about line 181)
- Modify: `scripts/update-completion-gate.rb` (the `record = …` block and the history row, about lines 196–214)
- Modify: `scripts/update-task-branch.rb` (the stored-state checks at about lines 72–87, the record at about line 102, the history row at about lines 108–114)
- Create: `tests/integration/plan-revisions.sh`

**Interfaces:**
- Consumes: nothing new.
- Produces (all `module_function` on `CompletionGuard`):
  - `gate_record(status:, actor:, reason:, updated_at:, evidence_refs: nil, requires_authorization: nil, authorization_refs: nil, authorization_through: nil) -> Hash`
  - `gate_history_row(gate_name, old_status, new_status, actor:, reason:, at:) -> Hash`
  - `branch_record(state:, actor:, reason:, updated_at:, waiting_for: []) -> Hash`
  - `branch_history_row(name, from:, to:, old_phase:, new_phase:, actor:, reason:, at:) -> Hash`
  - `branch_state_error(status) -> String or nil` (the first problem, worded exactly as the 1C writer words it today)

- [ ] **Step 1: Create the suite with its header, section W and the PASS line**

Create `tests/integration/plan-revisions.sh`:

````bash
#!/usr/bin/env bash
set -euo pipefail

# Issue #28 Phase 2A — plan revision record.
#
# A change of plan or scope is recorded as an append-only `revisions` entry in
# status.yaml by scripts/revise-task-plan.rb, which in the same write declares
# the gates and branches the change implies or records why there are none.
# Sections: W shared record construction (existing writers pinned byte for
# byte), V stored-state validation, R replay shapes, X refusals, I idempotency
# and ids, C concurrency/fence/corrupt state, G golden equivalence with the
# existing writers, S team sync and revert safety.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS="$(mktemp -d)"
trap 'rm -rf "$RUNS"' EXIT
export AI_OFFICE_RUNS_DIR="$RUNS"
unset AI_DEV_OFFICE_OWNERSHIP_EPOCH AI_DEV_OFFICE_RUN_ID AI_OFFICE_NOW
GATE="$ROOT/scripts/update-completion-gate.rb"
BRANCH="$ROOT/scripts/update-task-branch.rb"
AUTHZ="$ROOT/scripts/record-authorization.rb"
REVISE="$ROOT/scripts/revise-task-plan.rb"
FORCE="$ROOT/scripts/force-status-route.rb"
OWN="$ROOT/scripts/task-ownership.rb"
VALIDATOR="$ROOT/validate-yaml.rb"

fail() { echo "[FAIL] $1"; exit 1; }
assert_eq() { [[ "$1" == "$2" ]] || fail "$3: expected '$2', got '$1'"; }
# field <file> <dotted.path> — numeric segments index into lists; prints "" when absent.
field() {
  ruby -ryaml -rdate - "$1" "$2" <<'RUBY'
data = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time], aliases: true)
value = ARGV[1].split(".").reduce(data) do |node, key|
  if node.is_a?(Array) && key.match?(/\A\d+\z/) then node[key.to_i]
  elsif node.is_a?(Hash) then node[key]
  end
end
puts value.nil? ? "" : value
RUBY
}
# task <TASK_ID> [phase] — a minimal governed task (updated_at present, so key order is fixed).
task() {
  local dir="$RUNS/$1" phase="${2:-assigned}"
  mkdir -p "$dir"
  cat > "$dir/status.yaml" <<YAML
task_id: $1
phase: $phase
state: $phase
iteration: 1
current_agent: dev
ready: true
blocked_on: []
waiting_for: []
assignment:
  primary: dev
  parallel: false
updated_at: '2026-10-01'
history: []
YAML
  printf '# %s\n' "$1" > "$dir/task.md"
  echo "$dir"
}
normalize() {
  sed -E "s/'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'/'<TS>'/g; s/'[0-9]{4}-[0-9]{2}-[0-9]{2}'/'<DATE>'/g" "$1"
}

# --- W: shared record construction; the existing writers' bytes are pinned ---
ruby - "$ROOT" <<'RUBY'
require File.join(ARGV[0], "scripts", "completion-guard")
def check(label, actual, expected)
  abort "[FAIL] W #{label}: expected #{expected.inspect}, got #{actual.inspect}" unless actual == expected
end
check "gate_record declare, no reason",
      CompletionGuard.gate_record(status: "pending", actor: "pm", reason: "", updated_at: "T", requires_authorization: "live_load"),
      { "status" => "pending", "actor" => "pm", "updated_at" => "T", "evidence_refs" => [], "requires_authorization" => "live_load" }
check "gate_record bound pass key order",
      CompletionGuard.gate_record(status: "pass", actor: "rv", reason: "ran", updated_at: "T", evidence_refs: ["ev-001"],
                                  requires_authorization: "live_load", authorization_refs: ["authz-001"], authorization_through: "authz-002").keys,
      %w[status actor reason updated_at evidence_refs requires_authorization authorization_refs authorization_through]
check "gate_history_row default reason",
      CompletionGuard.gate_history_row("g", "absent", "pending", actor: "someone", reason: nil, at: "T"),
      { "phase" => "gate g: absent -> pending", "agent" => "orchestrator", "reason" => "completion gate declared", "at" => "T" }
check "branch_record blocked",
      CompletionGuard.branch_record(state: "blocked", actor: "pm", reason: "r", updated_at: "T", waiting_for: ["op: x"]),
      { "state" => "blocked", "actor" => "pm", "reason" => "r", "updated_at" => "T", "waiting_for" => ["op: x"] }
check "branch_record ready drops waiting_for",
      CompletionGuard.branch_record(state: "ready", actor: "pm", reason: "r", updated_at: "T", waiting_for: ["ignored"]),
      { "state" => "ready", "actor" => "pm", "reason" => "r", "updated_at" => "T" }
check "branch_history_row",
      CompletionGuard.branch_history_row("w", from: "declared", to: "ready", old_phase: "assigned", new_phase: "assigned", actor: "pm", reason: "r", at: "T"),
      { "phase" => "assigned -> assigned", "agent" => "pm", "reason" => "Branch w: declared -> ready; r", "at" => "T" }
check "branch_state_error clean", CompletionGuard.branch_state_error({ "waiting_for" => [] }), nil
check "branch_state_error non-map", CompletionGuard.branch_state_error({ "branches" => [] }), "status.yaml branches must be a map"
check "branch_state_error malformed",
      CompletionGuard.branch_state_error({ "branches" => { "w" => { "state" => "ready" } } }), "malformed existing branch \"w\""
check "branch_state_error waiting_for", CompletionGuard.branch_state_error({ "waiting_for" => "x" }), "status.yaml waiting_for must be a list"
check "branch_state_error blocked_on", CompletionGuard.branch_state_error({ "blocked_on" => "x" }), "status.yaml blocked_on must be a list"
check "branch_state_error reasons", CompletionGuard.branch_state_error({ "waiting_for" => [""] }), "status.yaml waiting_for must contain reasons"
RUBY

# Byte pin: this exact sequence through the EXISTING writers must keep producing
# exactly this file (timestamps normalized). Generated from main 2f3ecfe2.
mkdir -p "$RUNS/TASK-PIN-001"
cat > "$RUNS/TASK-PIN-001/status.yaml" <<'YAML'
task_id: TASK-PIN-001
phase: assigned
state: assigned
iteration: 1
current_agent: dev
ready: true
blocked_on: []
waiting_for: []
assignment:
  primary: dev
  parallel: false
history: []
YAML
AI_OFFICE_NOW=2026-10-08T01:00:00Z ruby "$GATE" TASK-PIN-001 declare source_merged --actor pm --reason "merge to main" >/dev/null
AI_OFFICE_NOW=2026-10-08T01:00:00Z ruby "$GATE" TASK-PIN-001 declare production_backfill --actor pm --requires-authorization production_backfill >/dev/null
AI_OFFICE_NOW=2026-10-08T01:00:00Z ruby "$AUTHZ" TASK-PIN-001 grant --action production_backfill --scope backfill --actor op --via chat --reason ok >/dev/null
AI_OFFICE_NOW=2026-10-08T01:05:00Z ruby "$GATE" TASK-PIN-001 pass production_backfill --actor reviewer --reason ran --authorization authz-001 >/dev/null
AI_OFFICE_NOW=2026-10-08T01:05:00Z ruby "$GATE" TASK-PIN-001 na source_merged --actor reviewer --reason "no code" >/dev/null
ruby "$BRANCH" TASK-PIN-001 declare wave_1 --actor pm --reason executable >/dev/null
ruby "$BRANCH" TASK-PIN-001 declare wave_2 --actor pm --reason "policy pending" --state blocked --waiting-for "operator: policy A/B/C" >/dev/null
ruby "$BRANCH" TASK-PIN-001 done wave_1 --actor dev --reason "wave 1 shipped" >/dev/null
cat > "$RUNS/pin.expected" <<'YAML'
---
task_id: TASK-PIN-001
phase: blocked
state: blocked
iteration: 1
current_agent: dev
ready: false
blocked_on: []
waiting_for:
- 'branch:wave_2 operator: policy A/B/C'
assignment:
  primary: dev
  parallel: false
history:
- phase: 'gate source_merged: absent -> pending'
  agent: pm
  reason: merge to main
  at: '<TS>'
- phase: 'gate production_backfill: absent -> pending'
  agent: pm
  reason: completion gate declared
  at: '<TS>'
- phase: 'gate production_backfill: pending -> pass'
  agent: reviewer
  reason: ran
  at: '<TS>'
- phase: 'gate source_merged: pending -> na'
  agent: reviewer
  reason: no code
  at: '<TS>'
- phase: assigned -> assigned
  agent: pm
  reason: 'Branch wave_1: declared -> ready; executable'
  at: '<TS>'
- phase: assigned -> assigned
  agent: pm
  reason: 'Branch wave_2: declared -> blocked; policy pending'
  at: '<TS>'
- phase: assigned -> blocked
  agent: dev
  reason: 'Branch wave_1: ready -> done; wave 1 shipped'
  at: '<TS>'
completion_gates:
  source_merged:
    status: na
    actor: reviewer
    reason: no code
    updated_at: '<TS>'
    evidence_refs: []
  production_backfill:
    status: pass
    actor: reviewer
    reason: ran
    updated_at: '<TS>'
    evidence_refs: []
    requires_authorization: production_backfill
    authorization_refs:
    - authz-001
    authorization_through: authz-001
updated_at: '<DATE>'
branches:
  wave_1:
    state: done
    actor: dev
    reason: wave 1 shipped
    updated_at: '<TS>'
  wave_2:
    state: blocked
    actor: pm
    reason: policy pending
    updated_at: '<TS>'
    waiting_for:
    - 'operator: policy A/B/C'
YAML
normalize "$RUNS/TASK-PIN-001/status.yaml" > "$RUNS/pin.actual"
diff -u "$RUNS/pin.expected" "$RUNS/pin.actual" || fail "W: the existing gate/branch writers' status.yaml bytes changed"

echo "[PASS] plan-revisions: plan revision record (#28 Phase 2A)"
````

- [ ] **Step 2: Run it and confirm the byte pin passes but the helper checks fail**

Run: `bash tests/integration/plan-revisions.sh`
Expected: FAIL with `undefined method 'gate_record' for CompletionGuard:Module` (NoMethodError) from the first Ruby block.

Then confirm the byte pin matches today's code before any refactor: comment out the first `ruby - "$ROOT" <<'RUBY' … RUBY` block, run the suite, see `[PASS]`, and restore the block. The pin **must** pass on unmodified code. If it does not, stop: the golden is wrong. Regenerate it from unmodified code; never adjust it afterwards to fit the refactor.

- [ ] **Step 3: Add the helpers to `CompletionGuard`**

In `scripts/completion-guard.rb`, directly after the `event_agent` method:

```ruby
  # Phase 2A: the one construction of a gate record, shared by
  # update-completion-gate.rb and revise-task-plan.rb. Key order is part of the
  # stored bytes (pinned by tests/integration/plan-revisions.sh section W).
  def gate_record(status:, actor:, reason:, updated_at:, evidence_refs: nil, requires_authorization: nil,
                  authorization_refs: nil, authorization_through: nil)
    record = { "status" => status, "actor" => actor }
    record["reason"] = reason unless reason.to_s.empty?
    record["updated_at"] = updated_at
    record["evidence_refs"] = Array(evidence_refs)
    record["requires_authorization"] = requires_authorization unless requires_authorization.nil?
    unless authorization_refs.nil?
      record["authorization_refs"] = authorization_refs
      record["authorization_through"] = authorization_through
    end
    record
  end

  def gate_history_row(gate_name, old_status, new_status, actor:, reason:, at:)
    {
      "phase" => "gate #{gate_name}: #{old_status} -> #{new_status}",
      "agent" => event_agent(actor),
      "reason" => reason.to_s.empty? ? "completion gate declared" : reason,
      "at" => at
    }
  end

  # Phase 2A: the one construction of a branch record and its history row,
  # shared by update-task-branch.rb and revise-task-plan.rb.
  def branch_record(state:, actor:, reason:, updated_at:, waiting_for: [])
    record = { "state" => state, "actor" => actor, "reason" => reason, "updated_at" => updated_at }
    record["waiting_for"] = waiting_for if state == "blocked"
    record
  end

  def branch_history_row(name, from:, to:, old_phase:, new_phase:, actor:, reason:, at:)
    {
      "phase" => "#{old_phase} -> #{new_phase}",
      "agent" => event_agent(actor),
      "reason" => "Branch #{name}: #{from} -> #{to}; #{reason}",
      "at" => at
    }
  end

  # The stored-branch-state checks a branch writer must pass before it builds
  # on status.yaml. Returns the first problem (the writers exit 3 on it) or nil.
  def branch_state_error(status)
    return "status.yaml branches must be a map" if status.key?("branches") && !status["branches"].is_a?(Hash)

    (status["branches"] || {}).each do |id, branch|
      valid = id.is_a?(String) && id.match?(BRANCH_NAME_PATTERN) && branch.is_a?(Hash) &&
              BRANCH_STATES.include?(branch["state"]) &&
              RESOLUTION_METADATA_KEYS.all? { |key| branch[key].is_a?(String) && !branch[key].strip.empty? } &&
              (branch.keys - %w[state actor reason updated_at waiting_for]).empty? &&
              (branch["state"] == "blocked" ?
                branch["waiting_for"].is_a?(Array) && !branch["waiting_for"].empty? &&
                  branch["waiting_for"].all? { |item| item.is_a?(String) && !item.strip.empty? } :
                !branch.key?("waiting_for"))
      return "malformed existing branch #{id.inspect}" unless valid
    end
    return "status.yaml waiting_for must be a list" if status.key?("waiting_for") && !status["waiting_for"].is_a?(Array)
    return "status.yaml blocked_on must be a list" if status.key?("blocked_on") && !status["blocked_on"].is_a?(Array)
    if Array(status["waiting_for"]).any? { |item| !item.is_a?(String) || item.strip.empty? }
      return "status.yaml waiting_for must contain reasons"
    end

    nil
  end
```

- [ ] **Step 4: Route `update-completion-gate.rb` through the helpers**

Replace the block from `record = { "status" => new_status, "actor" => opts[:actor] }` through `gates[gate_name] = record` with:

```ruby
gates[gate_name] = CompletionGuard.gate_record(
  status: new_status, actor: opts[:actor], reason: opts[:reason], updated_at: now,
  evidence_refs: opts[:evidence], requires_authorization: bound_action,
  authorization_refs: authorization_refs, authorization_through: authorization_through
)
```

Replace the `status["history"] << { "phase" => "gate #{gate_name}: …", … }` literal with:

```ruby
status["history"] << CompletionGuard.gate_history_row(gate_name, old_status, new_status,
                                                      actor: opts[:actor], reason: opts[:reason], at: now)
```

- [ ] **Step 5: Route `update-task-branch.rb` through the helpers**

Replace the lines from `refuse("status.yaml branches must be a map", 3) if …` through `refuse("status.yaml waiting_for must contain reasons", 3) if …` (the map check, the `branches.each` validity loop and the three `waiting_for`/`blocked_on` checks) with:

```ruby
branch_error = CompletionGuard.branch_state_error(status)
refuse(branch_error, 3) if branch_error
branches = (status["branches"] ||= {})
```

Replace the record construction (`record = { "state" => state, … }` and the `record["waiting_for"] = …` line) and `branches[name] = record` with:

```ruby
branches[name] = CompletionGuard.branch_record(state: state, actor: opts["actor"], reason: opts["reason"],
                                               updated_at: now, waiting_for: opts["waiting_for"])
```

Replace the history literal with:

```ruby
status["history"] << CompletionGuard.branch_history_row(
  name, from: action == "declare" ? "declared" : existing["state"], to: state,
  old_phase: old_phase, new_phase: status["phase"], actor: opts["actor"], reason: opts["reason"], at: now
)
```

- [ ] **Step 6: Run the new suite and the existing writer suites**

Run: `bash tests/integration/plan-revisions.sh`
Expected: `[PASS] plan-revisions: plan revision record (#28 Phase 2A)`

Run: `bash tests/integration/completion-gates.sh && bash tests/integration/partial-branches.sh && bash tests/integration/authorization-ledger.sh`
Expected: each prints its own `[PASS]` line and exits 0.

- [ ] **Step 7: Commit**

```bash
git -C /Users/earth/Documents/GitHub/ai-dev-office/.claude/worktrees/issue-28-2a-impl add scripts/completion-guard.rb scripts/update-completion-gate.rb scripts/update-task-branch.rb tests/integration/plan-revisions.sh
git -C /Users/earth/Documents/GitHub/ai-dev-office/.claude/worktrees/issue-28-2a-impl commit -m "refactor(office): share gate and branch record construction (#28 Phase 2A)

Move gate/branch record and history-row construction and the stored-branch
checks into CompletionGuard so the Phase 2A revision writer builds records
the same way. The existing writers' status.yaml bytes are pinned by a golden.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The revision record — library, validator, schema, parity

**Files:**
- Create: `scripts/plan-revisions.rb`
- Modify: `validate-yaml.rb` (requires block at the top; `validate_status`, directly after `validate_completion_gates(data, label, errors, task_dir)`)
- Modify: `schemas/status.schema.yaml` (insert a `revisions` property directly before `  handoff:`)
- Modify: `tests/integration/schema-validator-parity.sh` (require at the top; new checks directly before `failed = false`)
- Modify: `tests/integration/plan-revisions.sh` (section V)

**Interfaces:**
- Consumes: `CompletionGuard::GATE_NAME_PATTERN`, `AuthorizationLedger::TIMESTAMP_PATTERN`.
- Produces (`module_function` on `PlanRevisions`):
  - `KINDS` (frozen `%w[scope_expanded scope_narrowed plan_changed acceptance_changed]`), `ID_PATTERN` (`/\Arev-(\d{3,})\z/`)
  - `id_number(id) -> Integer or nil`; `format_id(number) -> "rev-%03d"`; `next_id(revisions) -> String` (max numeric suffix + 1; `rev-001` for none)
  - `content(kind:, actor:, reason:, gates:, branches:, no_new_gates:) -> Hash` (the entry without `id`/`at`; `no_new_gates: nil` means effects)
  - `build_entry(id:, at:, content:) -> Hash` (key order `id at kind actor reason effects|no_new_gates`)
  - `same_content?(entry, content) -> Boolean`
  - `stored_errors(status, label) -> Array<String>` (`[]` when `status` has no `revisions` key)

- [ ] **Step 1: Write section V (failing)**

Insert before the PASS line of `tests/integration/plan-revisions.sh`:

````bash
# --- V: stored-state rules for `revisions` (library + validator) ---
ruby - "$ROOT" <<'RUBY'
require File.join(ARGV[0], "scripts", "plan-revisions")
GATES = { "production_backfill" => { "status" => "pending", "actor" => "dev", "updated_at" => "2026-10-08T01:00:00Z", "evidence_refs" => [] } }
BRANCHES = { "wave_1" => { "state" => "ready", "actor" => "pm", "reason" => "r", "updated_at" => "2026-10-08T01:00:00Z" } }
def rev(id, extra = {})
  { "id" => id, "at" => "2026-10-08T01:00:00Z", "kind" => "plan_changed", "actor" => "dev", "reason" => "r", "no_new_gates" => "same path" }.merge(extra)
end
def eff(id, gates, branches)
  rev(id).reject { |key, _| key == "no_new_gates" }.merge("effects" => { "gates_declared" => gates, "branches_declared" => branches })
end
def errs(revisions)
  PlanRevisions.stored_errors({ "completion_gates" => GATES, "branches" => BRANCHES, "revisions" => revisions }, "s")
end
def ok(label, revisions)
  e = errs(revisions)
  abort "[FAIL] V #{label}: unexpected #{e.inspect}" unless e.empty?
end
def bad(label, revisions, fragment)
  e = errs(revisions)
  abort "[FAIL] V #{label}: expected an error containing #{fragment.inspect}, got #{e.inspect}" unless e.any? { |m| m.include?(fragment) }
end

abort "[FAIL] V absent key must be no errors" unless PlanRevisions.stored_errors({ "phase" => "assigned" }, "s").empty?
ok "assertion", [rev("rev-001")]
ok "effects", [eff("rev-001", ["production_backfill"], []), eff("rev-002", [], ["wave_1"])]
ok "numeric order past 999", [rev("rev-999"), rev("rev-1000"), rev("rev-1001")]
bad "not a list", { "x" => 1 }, "s.revisions must be a list"
bad "entry not a map", ["rev-001"], "s.revisions[0] must be a map"
bad "unknown key", [rev("rev-001", "note" => "x")], "s.revisions[0] has unknown field(s): note"
bad "bad id", [rev("rev-01")], "s.revisions[0].id must match rev-NNN"
bad "decreasing id", [rev("rev-002"), rev("rev-001")], "s.revisions[1].id rev-001 must be greater than"
bad "zero-padded duplicate", [rev("rev-001"), rev("rev-0001")], "s.revisions[1].id rev-0001 must be greater than"
bad "bad at", [rev("rev-001", "at" => "2026-10-08 01:00:00")], "s.revisions[0].at must be a UTC timestamp"
bad "bad kind", [rev("rev-001", "kind" => "scope_grew")], "s.revisions[0].kind must be one of"
bad "empty actor", [rev("rev-001", "actor" => " ")], "s.revisions[0].actor must be a non-empty string"
bad "missing reason", [rev("rev-001").reject { |k, _| k == "reason" }], "s.revisions[0].reason must be a non-empty string"
bad "both", [eff("rev-001", ["production_backfill"], []).merge("no_new_gates" => "x")], "exactly one of effects or no_new_gates"
bad "neither", [rev("rev-001").reject { |k, _| k == "no_new_gates" }], "exactly one of effects or no_new_gates"
bad "empty assertion", [rev("rev-001", "no_new_gates" => "")], "s.revisions[0].no_new_gates must be a non-empty string"
bad "effects not a map", [rev("rev-001").reject { |k, _| k == "no_new_gates" }.merge("effects" => [])], "s.revisions[0].effects must be a map with gates_declared and branches_declared"
bad "effects missing list", [rev("rev-001").reject { |k, _| k == "no_new_gates" }.merge("effects" => { "gates_declared" => [] })], "must be a map with gates_declared and branches_declared"
bad "effects both empty", [eff("rev-001", [], [])], "must declare at least one gate or branch"
bad "bad gate name", [eff("rev-001", ["Bad-Name"], [])], "s.revisions[0].effects.gates_declared must be a list of names"
bad "repeated name", [eff("rev-001", ["production_backfill", "production_backfill"], [])], "gates_declared lists a name twice"
bad "gate removed by hand", [eff("rev-001", ["gone_gate"], [])], "gates_declared names gone_gate, which is not in completion_gates"
bad "branch removed by hand", [eff("rev-001", [], ["gone_branch"])], "branches_declared names gone_branch, which is not in branches"

abort "[FAIL] V next_id empty" unless PlanRevisions.next_id([]) == "rev-001"
abort "[FAIL] V next_id 999" unless PlanRevisions.next_id([rev("rev-999")]) == "rev-1000"
abort "[FAIL] V next_id uses max, not last" unless PlanRevisions.next_id([rev("rev-1000"), rev("rev-999")]) == "rev-1001"
abort "[FAIL] V id_number" unless PlanRevisions.id_number("rev-0042") == 42 && PlanRevisions.id_number("REV-001").nil? && PlanRevisions.id_number(7).nil?
c = PlanRevisions.content(kind: "scope_expanded", actor: "dev", reason: "r", gates: ["g"], branches: [], no_new_gates: nil)
abort "[FAIL] V content effects" unless c == { "kind" => "scope_expanded", "actor" => "dev", "reason" => "r", "effects" => { "gates_declared" => ["g"], "branches_declared" => [] } }
e = PlanRevisions.build_entry(id: "rev-001", at: "2026-10-08T01:00:00Z", content: c)
abort "[FAIL] V build_entry key order: #{e.keys.inspect}" unless e.keys == %w[id at kind actor reason effects]
abort "[FAIL] V same_content? positive" unless PlanRevisions.same_content?(e, c)
abort "[FAIL] V same_content? negative" if PlanRevisions.same_content?(e, c.merge("reason" => "other"))
abort "[FAIL] V same_content? nil entry" if PlanRevisions.same_content?(nil, c)
RUBY

# The validator enforces the same rules on a stored status.yaml.
D="$(task TASK-901)"
cat >> "$D/status.yaml" <<'YAML'
revisions:
- id: rev-001
  at: '2026-10-08T01:00:00Z'
  kind: scope_grew
  actor: dev
  reason: r
  no_new_gates: same path
YAML
rc=0; ruby "$VALIDATOR" "$D/status.yaml" >"$RUNS/validate.log" 2>&1 || rc=$?
[[ "$rc" != "0" ]] || fail "V: the validator accepted an unknown revision kind"
grep -q "revisions\[0\].kind must be one of" "$RUNS/validate.log" || fail "V: validator message missing: $(cat "$RUNS/validate.log")"
ruby -e 'p = ARGV[0]; File.write(p, File.read(p).sub("kind: scope_grew", "kind: plan_changed"))' "$D/status.yaml"
ruby "$VALIDATOR" "$D/status.yaml" >"$RUNS/validate.log" 2>&1 || fail "V: a valid revision was rejected: $(cat "$RUNS/validate.log")"
D="$(task TASK-902)"
ruby "$VALIDATOR" "$D/status.yaml" >"$RUNS/validate.log" 2>&1 || fail "V: a task without revisions no longer validates: $(cat "$RUNS/validate.log")"
````

- [ ] **Step 2: Run to verify it fails**

Run: `bash tests/integration/plan-revisions.sh`
Expected: FAIL with `cannot load such file -- …/scripts/plan-revisions` (LoadError).

- [ ] **Step 3: Write `scripts/plan-revisions.rb`**

```ruby
#!/usr/bin/env ruby
# frozen_string_literal: true

# Phase 2A plan revision record (issue #28). The one definition of a
# `revisions` entry in status.yaml: its id arithmetic, the entry the writer
# (scripts/revise-task-plan.rb) appends, and the stored-state rules
# validate-yaml.rb enforces. Writer and validator both require this file so
# they cannot drift. A revision authorizes nothing and decides nothing; it
# records a change and names the gates/branches it added (docs/plan-revisions.md).

require_relative "completion-guard"
require_relative "authorization-ledger"

module PlanRevisions
  KINDS = %w[scope_expanded scope_narrowed plan_changed acceptance_changed].freeze
  ID_PATTERN = /\Arev-(\d{3,})\z/.freeze
  ENTRY_KEYS = %w[id at kind actor reason effects no_new_gates].freeze
  EFFECT_KEYS = %w[branches_declared gates_declared].freeze

  module_function

  # Ids are ordered by their numeric suffix, never as strings ("rev-1000" < "rev-999").
  def id_number(id)
    match = id.is_a?(String) ? ID_PATTERN.match(id) : nil
    match ? match[1].to_i : nil
  end

  def format_id(number)
    format("rev-%03d", number)
  end

  def next_id(revisions)
    numbers = Array(revisions).map { |entry| id_number(entry["id"]) if entry.is_a?(Hash) }.compact
    format_id((numbers.max || 0) + 1)
  end

  # The entry without id and at: what makes two revisions "the same".
  def content(kind:, actor:, reason:, gates:, branches:, no_new_gates:)
    entry = { "kind" => kind, "actor" => actor, "reason" => reason }
    if no_new_gates.nil?
      entry["effects"] = { "gates_declared" => gates, "branches_declared" => branches }
    else
      entry["no_new_gates"] = no_new_gates
    end
    entry
  end

  def build_entry(id:, at:, content:)
    { "id" => id, "at" => at }.merge(content)
  end

  def same_content?(entry, content)
    entry.is_a?(Hash) && entry.reject { |key, _| %w[id at].include?(key) } == content
  end

  def stored_errors(status, label)
    return [] unless status.is_a?(Hash) && status.key?("revisions")

    revisions = status["revisions"]
    return ["#{label}.revisions must be a list of revision records"] unless revisions.is_a?(Array)

    gates = status["completion_gates"].is_a?(Hash) ? status["completion_gates"] : {}
    branches = status["branches"].is_a?(Hash) ? status["branches"] : {}
    errors = []
    previous = nil
    revisions.each_with_index do |entry, index|
      rlabel = "#{label}.revisions[#{index}]"
      unless entry.is_a?(Hash)
        errors << "#{rlabel} must be a map"
        next
      end
      unknown = entry.keys - ENTRY_KEYS
      errors << "#{rlabel} has unknown field(s): #{unknown.join(', ')}" unless unknown.empty?
      number = id_number(entry["id"])
      if number.nil?
        errors << "#{rlabel}.id must match rev-NNN (three or more digits)"
      else
        if previous && number <= previous
          errors << "#{rlabel}.id #{entry['id']} must be greater than the previous revision id (numeric order)"
        end
        previous = number
      end
      unless entry["at"].is_a?(String) && entry["at"].match?(AuthorizationLedger::TIMESTAMP_PATTERN)
        errors << "#{rlabel}.at must be a UTC timestamp YYYY-MM-DDTHH:MM:SSZ"
      end
      errors << "#{rlabel}.kind must be one of #{KINDS.join(', ')}" unless KINDS.include?(entry["kind"])
      %w[actor reason].each do |key|
        errors << "#{rlabel}.#{key} must be a non-empty string" unless entry[key].is_a?(String) && !entry[key].strip.empty?
      end
      if entry.key?("effects") == entry.key?("no_new_gates")
        errors << "#{rlabel} must have exactly one of effects or no_new_gates"
      elsif entry.key?("no_new_gates")
        unless entry["no_new_gates"].is_a?(String) && !entry["no_new_gates"].strip.empty?
          errors << "#{rlabel}.no_new_gates must be a non-empty string"
        end
      else
        errors.concat(effects_errors(entry["effects"], "#{rlabel}.effects", gates, branches))
      end
    end
    errors
  end

  def effects_errors(effects, elabel, gates, branches)
    unless effects.is_a?(Hash) && effects.keys.sort == EFFECT_KEYS
      return ["#{elabel} must be a map with gates_declared and branches_declared"]
    end

    errors = []
    { "gates_declared" => [gates, "completion_gates"], "branches_declared" => [branches, "branches"] }.each do |key, (declared, noun)|
      names = effects[key]
      unless names.is_a?(Array) && names.all? { |name| name.is_a?(String) && name.match?(CompletionGuard::GATE_NAME_PATTERN) }
        errors << "#{elabel}.#{key} must be a list of names matching #{CompletionGuard::GATE_NAME_PATTERN.inspect}"
        next
      end
      errors << "#{elabel}.#{key} lists a name twice" unless names.uniq.size == names.size
      missing = names.reject { |name| declared.key?(name) }
      errors << "#{elabel}.#{key} names #{missing.join(', ')}, which is not in #{noun}" unless missing.empty?
    end
    if errors.empty? && effects["gates_declared"].empty? && effects["branches_declared"].empty?
      errors << "#{elabel} must declare at least one gate or branch (use no_new_gates otherwise)"
    end
    errors
  end
end
```

- [ ] **Step 4: Wire the validator**

In `validate-yaml.rb`, add after `require_relative "scripts/branch-projection"`:

```ruby
require_relative "scripts/plan-revisions"
```

In `validate_status`, directly after `validate_completion_gates(data, label, errors, task_dir)`:

```ruby
  errors.concat(PlanRevisions.stored_errors(data, label))
```

- [ ] **Step 5: Run section V to verify it passes**

Run: `bash tests/integration/plan-revisions.sh`
Expected: `[PASS] plan-revisions: plan revision record (#28 Phase 2A)`

- [ ] **Step 6: Add the parity checks (failing)**

In `tests/integration/schema-validator-parity.sh`, add after `require File.join(Dir.pwd, "scripts", "authorization-ledger")`:

```ruby
require File.join(Dir.pwd, "scripts", "plan-revisions")
```

Directly before `failed = false`:

```ruby
# --- plan revisions (issue #28 Phase 2A) ----------------------------------------
rev_item = YAML.load_file("schemas/status.schema.yaml")["properties"]["revisions"]["items"]
checks << ["status.revisions.kind", PlanRevisions::KINDS.sort, rev_item["properties"]["kind"]["enum"].sort]
rev_samples = %w[rev-001 rev-0001 rev-1000 rev-01 rev-1 rev-abc REV-001 rev-001x]
checks << ["status.revisions.id grammar", rev_samples.map { |s| !PlanRevisions.id_number(s).nil? },
           rev_samples.map { |s| Regexp.new(rev_item["properties"]["id"]["pattern"]).match?(s) }]
checks << ["status.revisions.at grammar", ts_validator,
           ts_samples.map { |s| Regexp.new(rev_item["properties"]["at"]["pattern"]).match?(s) }]
checks << ["status.revisions effect names", ["a", "wave_1", "Bad", "1a", "a-b", ""].map { |s| CompletionGuard::GATE_NAME_PATTERN.match?(s) },
           ["a", "wave_1", "Bad", "1a", "a-b", ""].map { |s| Regexp.new(rev_item["properties"]["effects"]["properties"]["gates_declared"]["items"]["pattern"]).match?(s) }]
# --- end plan revisions block ---------------------------------------------------
```

Run: `bash tests/integration/schema-validator-parity.sh`
Expected: FAIL. The `["revisions"]` lookup on the schema returns nil and raises `undefined method '[]' for nil:NilClass` (NoMethodError).

- [ ] **Step 7: Add `revisions` to the schema**

In `schemas/status.schema.yaml`, insert directly before the line `  handoff:`:

```yaml
  revisions:
    type: array
    description: >
      Phase 2A plan revision record (issue #28). Append-only; written only by
      scripts/revise-task-plan.rb. Each entry either names the gates and
      branches the change declared (effects) or says why it declared none
      (no_new_gates). Ids are ordered by numeric suffix, never as strings,
      and must strictly increase in file order; every name in effects must
      exist in completion_gates / branches. See docs/plan-revisions.md.
    items:
      type: object
      additionalProperties: false
      required:
        - id
        - at
        - kind
        - actor
        - reason
      oneOf:
        - required:
            - effects
        - required:
            - no_new_gates
      properties:
        id:
          type: string
          pattern: "^rev-[0-9]{3,}$"
        at:
          type: string
          pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"
        kind:
          type: string
          enum:
            - scope_expanded
            - scope_narrowed
            - plan_changed
            - acceptance_changed
        actor:
          type: string
          minLength: 1
        reason:
          type: string
          minLength: 1
        no_new_gates:
          type: string
          minLength: 1
        effects:
          type: object
          additionalProperties: false
          required:
            - gates_declared
            - branches_declared
          properties:
            gates_declared:
              type: array
              items:
                type: string
                pattern: "^[a-z][a-z0-9_]*$"
            branches_declared:
              type: array
              items:
                type: string
                pattern: "^[a-z][a-z0-9_]*$"
```

- [ ] **Step 8: Run parity and the suite**

Run: `bash tests/integration/schema-validator-parity.sh`
Expected: four new `ok:` lines (`status.revisions.kind (4 values agree)`, `status.revisions.id grammar`, `status.revisions.at grammar`, `status.revisions effect names`) and `[PASS] schema-validator-parity: …`

Run: `bash tests/integration/plan-revisions.sh`
Expected: `[PASS] plan-revisions: …`

- [ ] **Step 9: Commit**

```bash
git -C /Users/earth/Documents/GitHub/ai-dev-office/.claude/worktrees/issue-28-2a-impl add scripts/plan-revisions.rb validate-yaml.rb schemas/status.schema.yaml tests/integration/schema-validator-parity.sh tests/integration/plan-revisions.sh
git -C /Users/earth/Documents/GitHub/ai-dev-office/.claude/worktrees/issue-28-2a-impl commit -m "feat(office): plan revision record and its stored-state rules (#28 Phase 2A)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The governed writer `revise-task-plan.rb`

**Files:**
- Create: `scripts/revise-task-plan.rb`
- Modify: `tests/integration/plan-revisions.sh` (sections R, X, I, C, G, S)

**Interfaces:**
- Consumes: `CompletionGuard.gate_record`, `gate_history_row`, `branch_record`, `branch_history_row`, `branch_state_error`, `event_agent`, `append_meta_event!` (Task 1); `PlanRevisions.*` (Task 2); `BranchProjection.apply!`, `BranchProjection::UPDATABLE_PHASES`; `AuthorizationLedger::ACTIONS`, `now_utc`, `format_time`; `TaskOwnership.fence!`.
- Produces: the CLI

  ```
  ruby scripts/revise-task-plan.rb <TASK_ID> <kind> --actor A --reason R
      ( [--gate NAME[:ACTION]]... [--branch NAME:ready | --branch NAME:blocked:WAITING]...
        | --no-new-gates WHY )
  ```

  stdout on success: `plan revision rev-NNN: <kind> (task <phase>)`. On an idempotent repeat: `plan revision rev-NNN already recorded`. Meta event: type `plan_revised`, details `revision=rev-NNN kind=<kind> gates=<a,b> branches=<c> task_phase=<p>`, or `… no_new_gates task_phase=<p>` for an assertion.

- [ ] **Step 1: Write sections R, X, I, C, G, S (failing)**

Insert before the PASS line:

````bash
revise() { ruby "$REVISE" "$@"; }
force_done() { ruby "$FORCE" "$1" "$RUNS/$1/status.yaml" 2026-10-08 done done reviewer "accept" >"$RUNS/force.log" 2>&1; }
validate() { ruby "$VALIDATOR" "$1" >"$RUNS/validate.log" 2>&1; }
# last_revised <task dir> — details of the last plan_revised meta event (YAML.dump may fold long lines, so never grep it).
last_revised() {
  ruby -ryaml -rdate -e 'm = YAML.safe_load(File.read(File.join(ARGV[0], "meta.yaml")), permitted_classes: [Date, Time]) || {}
    e = Array(m["events"]).select { |x| x["type"] == "plan_revised" }.last; puts e ? e["details"] : ""' "$1"
}
# expect_refusal <exit> <label> <TASK_ID> <revise args...> — exit code matches and nothing is written.
expect_refusal() {
  local code="$1" label="$2" task_id="$3"; shift 3
  local status="$RUNS/$task_id/status.yaml"
  [[ -f "$status" ]] && cp "$status" "$RUNS/before.yaml"
  rc=0; ruby "$REVISE" "$task_id" "$@" >/dev/null 2>"$RUNS/refusal.log" || rc=$?
  assert_eq "$rc" "$code" "X $label exit ($(cat "$RUNS/refusal.log"))"
  if [[ -f "$status" ]]; then cmp -s "$status" "$RUNS/before.yaml" || fail "X $label wrote status.yaml"; fi
}

# --- R: replay shapes from the five VerifySlip runs ---
# VS-010: a small fix in review grows into a production backfill.
D="$(task TASK-910 review)"
out="$(revise TASK-910 scope_expanded --actor dev --reason "operator chose to backfill rows written with the old timezone" --gate production_backfill:production_backfill)"
assert_eq "$out" "plan revision rev-001: scope_expanded (task review)" "R VS-010 output"
assert_eq "$(field "$D/status.yaml" completion_gates.production_backfill.status)" "pending" "R VS-010 gate pending"
assert_eq "$(field "$D/status.yaml" completion_gates.production_backfill.requires_authorization)" "production_backfill" "R VS-010 gate bound"
assert_eq "$(field "$D/status.yaml" revisions.0.effects.gates_declared.0)" "production_backfill" "R VS-010 revision names the gate"
assert_eq "$(field "$D/status.yaml" revisions.0.id)" "rev-001" "R VS-010 id"
validate "$D/status.yaml" || fail "R VS-010 invalid: $(cat "$RUNS/validate.log")"
assert_eq "$(last_revised "$D")" "revision=rev-001 kind=scope_expanded gates=production_backfill branches= task_phase=review" "R VS-010 plan_revised meta event"
if force_done TASK-910; then fail "R VS-010 a revision's gate did not block done"; fi
grep -q "production_backfill" "$RUNS/force.log" || fail "R VS-010 refusal does not name the gate"
ruby "$AUTHZ" TASK-910 grant --action production_backfill --scope "timezone backfill" --actor operator --via chat --reason approved >/dev/null
ruby "$GATE" TASK-910 pass production_backfill --actor reviewer --reason "backfill ran" --authorization authz-001 >/dev/null
force_done TASK-910 || fail "R VS-010 done refused after the bound gate passed: $(cat "$RUNS/force.log")"

# VS-004: one task splits into an executable wave and a decision-blocked wave.
D="$(task TASK-912)"
revise TASK-912 plan_changed --actor pm --reason "wave 2 waits on the fairness policy" \
  --branch wave_1:ready --branch "wave_2:blocked:operator: fairness policy A/B/C" >/dev/null
assert_eq "$(field "$D/status.yaml" phase)" "assigned" "R VS-004 ready sibling keeps task assigned"
assert_eq "$(field "$D/status.yaml" branches.wave_2.waiting_for.0)" "operator: fairness policy A/B/C" "R VS-004 colon in waiting text kept whole"
assert_eq "$(field "$D/status.yaml" waiting_for.0)" "branch:wave_2 operator: fairness policy A/B/C" "R VS-004 projection applied"
validate "$D/status.yaml" || fail "R VS-004 invalid: $(cat "$RUNS/validate.log")"
if force_done TASK-912; then fail "R VS-004 an unresolved branch allowed done"; fi
grep -q "branch:wave_1" "$RUNS/force.log" || fail "R VS-004 refusal does not name the branch"

# Only a blocked branch: the task moves to blocked exactly as the 1C writer would.
D="$(task TASK-913)"
revise TASK-913 scope_expanded --actor pm --reason "hold for the operator" --branch "hold:blocked:operator decision" >/dev/null
assert_eq "$(field "$D/status.yaml" phase)" "blocked" "R blocked-only branch blocks task"
assert_eq "$(field "$D/status.yaml" ready)" "false" "R blocked-only branch clears ready"
assert_eq "$(field "$D/status.yaml" history.0.phase)" "assigned -> blocked" "R branch history row shows the phase move"
assert_eq "$(field "$D/status.yaml" history.1.phase)" "plan revision rev-001: scope_expanded" "R revision history row last"
validate "$D/status.yaml" || fail "R blocked-only invalid: $(cat "$RUNS/validate.log")"

# VS-006: a second root cause on the same files — no new gate, said explicitly.
D="$(task TASK-914 review)"
revise TASK-914 plan_changed --actor dev --reason "second root cause found in staging" --no-new-gates "same files and the same deploy path" >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates)" "" "R VS-006 no gate created"
assert_eq "$(field "$D/status.yaml" branches)" "" "R VS-006 no branch created"
assert_eq "$(field "$D/status.yaml" revisions.0.no_new_gates)" "same files and the same deploy path" "R VS-006 assertion stored"
assert_eq "$(last_revised "$D")" "revision=rev-001 kind=plan_changed no_new_gates task_phase=review" "R VS-006 meta details"
validate "$D/status.yaml" || fail "R VS-006 invalid: $(cat "$RUNS/validate.log")"

# VS-003: two consecutive revisions.
D="$(task TASK-915 review)"
revise TASK-915 scope_expanded --actor operator --reason "bank budget raised 700 -> 1200" --gate live_load:live_load >/dev/null
revise TASK-915 plan_changed --actor dev --reason "lock contention, not the bank limit" --no-new-gates "the live_load gate already covers it" >/dev/null
assert_eq "$(field "$D/status.yaml" revisions.0.id) $(field "$D/status.yaml" revisions.1.id)" "rev-001 rev-002" "R VS-003 ids"
validate "$D/status.yaml" || fail "R VS-003 invalid: $(cat "$RUNS/validate.log")"

# --- X: refusals write nothing ---
D="$(task TASK-920)"
ruby "$GATE" TASK-920 declare existing_gate --actor pm --reason r >/dev/null
ruby "$BRANCH" TASK-920 declare existing_branch --actor pm --reason r >/dev/null
expect_refusal 2 "bare revision" TASK-920 scope_expanded --actor a --reason r
expect_refusal 2 "effects and assertion" TASK-920 scope_expanded --actor a --reason r --gate x --no-new-gates why
expect_refusal 2 "empty assertion" TASK-920 plan_changed --actor a --reason r --no-new-gates ""
expect_refusal 2 "missing actor" TASK-920 plan_changed --reason r --no-new-gates why
expect_refusal 2 "unknown kind" TASK-920 scope_grew --actor a --reason r --no-new-gates why
expect_refusal 2 "unknown flag" TASK-920 plan_changed --actor a --reason r --no-new-gates why --force yes
expect_refusal 2 "unknown action" TASK-920 scope_expanded --actor a --reason r --gate x:deploy_prod
expect_refusal 2 "malformed gate name" TASK-920 scope_expanded --actor a --reason r --gate Bad-Name
expect_refusal 2 "empty gate action" TASK-920 scope_expanded --actor a --reason r --gate "x:"
expect_refusal 2 "gate spec with two colons" TASK-920 scope_expanded --actor a --reason r --gate "x:live_load:y"
expect_refusal 2 "blocked branch without text" TASK-920 scope_expanded --actor a --reason r --branch x:blocked
expect_refusal 2 "blocked branch with empty text" TASK-920 scope_expanded --actor a --reason r --branch "x:blocked: "
expect_refusal 2 "ready branch with text" TASK-920 scope_expanded --actor a --reason r --branch "x:ready:oops"
expect_refusal 2 "unknown branch state" TASK-920 scope_expanded --actor a --reason r --branch x:done
expect_refusal 2 "malformed branch name" TASK-920 scope_expanded --actor a --reason r --branch Bad:ready
expect_refusal 2 "gate twice in one call" TASK-920 scope_expanded --actor a --reason r --gate x --gate x
expect_refusal 2 "branch twice in one call" TASK-920 scope_expanded --actor a --reason r --branch x:ready --branch x:ready
expect_refusal 2 "atomic: later gate already declared" TASK-920 scope_expanded --actor a --reason r --gate fresh_gate --gate existing_gate
assert_eq "$(field "$RUNS/TASK-920/status.yaml" completion_gates.fresh_gate)" "" "X atomic refusal created no first gate"
expect_refusal 2 "existing branch" TASK-920 scope_expanded --actor a --reason r --branch existing_branch:ready
D="$(task TASK-921 done)"
expect_refusal 2 "done task" TASK-921 plan_changed --actor a --reason r --no-new-gates why
D="$(task TASK-922 aborted)"
expect_refusal 2 "aborted task" TASK-922 plan_changed --actor a --reason r --no-new-gates why
expect_refusal 3 "missing task" TASK-929 plan_changed --actor a --reason r --no-new-gates why
[[ ! -f "$RUNS/TASK-920/meta.yaml" ]] || assert_eq "$(last_revised "$RUNS/TASK-920")" "" "X a refusal appended a plan_revised event"

# --- I: idempotency and ids ---
D="$(task TASK-930)"
revise TASK-930 scope_expanded --actor dev --reason "grew" --gate g1 >/dev/null
cp "$D/status.yaml" "$RUNS/before.yaml"
out="$(revise TASK-930 scope_expanded --actor dev --reason "grew" --gate g1)"
assert_eq "$out" "plan revision rev-001 already recorded" "I identical repeat is a no-op"
cmp -s "$D/status.yaml" "$RUNS/before.yaml" || fail "I identical repeat changed status.yaml"
D="$(task TASK-932)"
revise TASK-932 plan_changed --actor dev --reason r1 --no-new-gates n >/dev/null
revise TASK-932 plan_changed --actor dev --reason r2 --no-new-gates n >/dev/null
out="$(revise TASK-932 plan_changed --actor dev --reason r1 --no-new-gates n)"
assert_eq "$out" "plan revision rev-003: plan_changed (task assigned)" "I repeat of an earlier, non-last revision is recorded"
D="$(task TASK-931)"
revise TASK-931 scope_expanded --actor dev --reason "grew" --gate g:production_backfill >/dev/null
expect_refusal 2 "same revision, different binding" TASK-931 scope_expanded --actor dev --reason "grew" --gate g
D="$(task TASK-933)"
revise TASK-933 scope_expanded --actor dev --reason "grew" --gate g >/dev/null
ruby -ryaml -rdate -e 'p = ARGV[0]; s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time]); s["completion_gates"].delete("g"); File.write(p, YAML.dump(s))' "$D/status.yaml"
if validate "$D/status.yaml"; then fail "I a hand-removed revision gate validated"; fi
grep -q "gates_declared names g, which is not in completion_gates" "$RUNS/validate.log" || fail "I validator message: $(cat "$RUNS/validate.log")"
expect_refusal 3 "writer refuses to build on a broken record" TASK-933 plan_changed --actor dev --reason r --no-new-gates n
D="$(task TASK-934)"
cat >> "$D/status.yaml" <<'YAML'
revisions:
- {id: rev-998, at: '2026-10-08T01:00:00Z', kind: plan_changed, actor: dev, reason: a, no_new_gates: n}
- {id: rev-999, at: '2026-10-08T01:00:00Z', kind: plan_changed, actor: dev, reason: b, no_new_gates: n}
YAML
assert_eq "$(revise TASK-934 plan_changed --actor dev --reason c --no-new-gates n)" "plan revision rev-1000: plan_changed (task assigned)" "I id crosses 999"
assert_eq "$(revise TASK-934 plan_changed --actor dev --reason d --no-new-gates n)" "plan revision rev-1001: plan_changed (task assigned)" "I and keeps growing"
validate "$D/status.yaml" || fail "I ids past 999 invalid: $(cat "$RUNS/validate.log")"

# --- C: concurrency, ownership fence, unreadable state ---
D="$(task TASK-940)"
for i in 1 2 3 4 5 6; do revise TASK-940 plan_changed --actor dev --reason "parallel $i" --no-new-gates n >/dev/null & done
wait
ruby -ryaml -rdate - "$D/status.yaml" <<'RUBY' || fail "C concurrent writers lost or duplicated a revision"
s = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time])
ids = s["revisions"].map { |r| r["id"] }
reasons = s["revisions"].map { |r| r["reason"] }.sort
abort "ids #{ids.inspect}" unless ids == %w[rev-001 rev-002 rev-003 rev-004 rev-005 rev-006]
abort "reasons #{reasons.inspect}" unless reasons == (1..6).map { |i| "parallel #{i}" }
abort "history" unless s["history"].count { |h| h["phase"].start_with?("plan revision ") } == 6
RUBY
D="$(task TASK-941)"
AI_DEV_OFFICE_HOME="$ROOT" AI_DEV_OFFICE_RUN_ID="run-holder" ruby "$OWN" acquire "$D" TASK-941 agent=dev "worktree=$RUNS/wt" >/dev/null 2>&1 \
  || fail "C test setup: could not acquire a lease"
cp "$D/status.yaml" "$RUNS/before.yaml"
rc=0; AI_DEV_OFFICE_HOME="$ROOT" ruby "$REVISE" TASK-941 plan_changed --actor dev --reason r --no-new-gates n >/dev/null 2>&1 || rc=$?
assert_eq "$rc" "9" "C ownership fence"
cmp -s "$D/status.yaml" "$RUNS/before.yaml" || fail "C a fenced writer wrote status.yaml"
D="$(task TASK-942)"; printf 'task_id: TASK-942\nphase: [\n' > "$D/status.yaml"
expect_refusal 3 "corrupt status.yaml" TASK-942 plan_changed --actor dev --reason r --no-new-gates n
D="$(task TASK-943)"; printf 'revisions: not a list\n' >> "$D/status.yaml"
expect_refusal 3 "revisions not a list" TASK-943 plan_changed --actor dev --reason r --no-new-gates n
D="$(task TASK-944)"; printf 'completion_gates: []\n' >> "$D/status.yaml"
expect_refusal 3 "completion_gates not a map" TASK-944 scope_expanded --actor dev --reason r --gate g
D="$(task TASK-945)"; printf 'branches: []\n' >> "$D/status.yaml"
expect_refusal 3 "branches not a map" TASK-945 scope_expanded --actor dev --reason r --branch w:ready

# --- G: a revision builds exactly what the existing writers would ---
task TASK-950 >/dev/null
task TASK-951 >/dev/null
revise TASK-950 scope_expanded --actor pm --reason grew --gate prod_deploy:deploy_production --gate smoke \
  --branch wave_1:ready --branch "wave_2:blocked:ops: window" >/dev/null
ruby "$GATE" TASK-951 declare prod_deploy --actor pm --reason grew --requires-authorization deploy_production >/dev/null
ruby "$GATE" TASK-951 declare smoke --actor pm --reason grew >/dev/null
ruby "$BRANCH" TASK-951 declare wave_1 --actor pm --reason grew >/dev/null
ruby "$BRANCH" TASK-951 declare wave_2 --actor pm --reason grew --state blocked --waiting-for "ops: window" >/dev/null
strip_revision() {
  ruby -ryaml -rdate - "$1" <<'RUBY'
s = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time])
s.delete("revisions")
s["task_id"] = "TASK-X"
s["history"] = s["history"].reject { |h| h["phase"].start_with?("plan revision ") }
puts YAML.dump(s)
RUBY
}
strip_revision "$RUNS/TASK-950/status.yaml" > "$RUNS/g.rev"; normalize "$RUNS/g.rev" > "$RUNS/g.rev.n"
strip_revision "$RUNS/TASK-951/status.yaml" > "$RUNS/g.seq"; normalize "$RUNS/g.seq" > "$RUNS/g.seq.n"
diff -u "$RUNS/g.seq.n" "$RUNS/g.rev.n" || fail "G the revision writer's gates/branches/history differ from the existing writers'"

# --- S: team sync and revert safety ---
mkdir -p "$RUNS/sync/TASK-910"
cp "$RUNS/TASK-910/status.yaml" "$RUNS/TASK-910/task.md" "$RUNS/TASK-910/authorization.yaml" "$RUNS/sync/TASK-910/"
ruby "$VALIDATOR" "$RUNS/sync/TASK-910/status.yaml" >"$RUNS/validate.log" 2>&1 \
  || fail "S a git-synced copy (status, task, authorization) does not validate: $(cat "$RUNS/validate.log")"
D="$(task TASK-911 review)"
revise TASK-911 scope_expanded --actor dev --reason "grew" --gate production_backfill:production_backfill --branch wave_1:ready >/dev/null
ruby -ryaml -rdate -e 'p = ARGV[0]; s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time]); s.delete("revisions"); File.write(p, YAML.dump(s))' "$D/status.yaml"
validate "$D/status.yaml" || fail "S status without revisions (as after a revert) invalid: $(cat "$RUNS/validate.log")"
if force_done TASK-911; then fail "S after a revert the revision's gate no longer blocks done"; fi
````

- [ ] **Step 2: Run to verify it fails**

Run: `bash tests/integration/plan-revisions.sh`
Expected: FAIL at the first R assertion. `revise` exits 1 with `No such file or directory -- …/scripts/revise-task-plan.rb`, and `set -e` stops the suite, or `[FAIL] R VS-010 output` appears.

- [ ] **Step 3: Write `scripts/revise-task-plan.rb`**

```ruby
#!/usr/bin/env ruby
# frozen_string_literal: true

# Governed Phase 2A writer (issue #28). Records a change of plan or scope as
# an append-only `revisions` entry in status.yaml and, in the SAME write,
# declares the completion gates and branches the change implies, or records
# why it implies none. A bare revision cannot be recorded. Gates and branches
# it declares are ordinary records, built exactly as update-completion-gate.rb
# and update-task-branch.rb build them; their existing guards give the teeth.
# This is not an authority system: actor and reason are unverified free text.
# See docs/plan-revisions.md.
#
# Usage:
#   ruby scripts/revise-task-plan.rb <TASK_ID> <kind> --actor A --reason R
#       ( [--gate NAME[:ACTION]]... [--branch NAME:ready | --branch NAME:blocked:WAITING]...
#         | --no-new-gates WHY )
#
# Exit: 0 recorded, or the identical last revision is already recorded;
# 2 usage error or refused revision; 3 unreadable or malformed status.yaml,
# revisions, completion_gates or branches; 9 ownership fence refused (raised
# by TaskOwnership.fence!, see docs/task-ownership.md).

require "yaml"
require "date"
require "time"
require_relative "task-ownership"
require_relative "completion-guard"
require_relative "branch-projection"
require_relative "authorization-ledger"
require_relative "plan-revisions"

FINISHED_PHASES = %w[done aborted].freeze

def refuse(message, code = 2)
  warn "revise-task-plan: #{message}"
  exit code
end

task_id, kind, *args = ARGV
refuse("expected TASK_ID KIND --actor A --reason R (--gate ... | --branch ... | --no-new-gates WHY)") unless task_id && kind
refuse("invalid task id") unless task_id.match?(/\ATASK(?:-[A-Z][A-Z0-9]*)?-\d+\z/)
refuse("unknown kind #{kind.inspect} (expected #{PlanRevisions::KINDS.join(', ')})") unless PlanRevisions::KINDS.include?(kind)

opts = { gates: [], branches: [] }
until args.empty?
  flag = args.shift
  value = args.shift
  refuse("#{flag} needs a value") if value.nil?
  case flag
  when "--actor", "--reason", "--no-new-gates"
    key = flag.delete_prefix("--").tr("-", "_").to_sym
    refuse("duplicate #{flag}") if opts.key?(key)
    opts[key] = value.strip
  when "--gate"
    name, action, extra = value.strip.split(":", 3)
    if extra || name.to_s.empty? || (value.include?(":") && action.to_s.empty?)
      refuse("--gate takes NAME or NAME:ACTION, got #{value.inspect}")
    end
    refuse("gate name #{name.inspect} must match #{CompletionGuard::GATE_NAME_PATTERN.inspect}") unless name.match?(CompletionGuard::GATE_NAME_PATTERN)
    if action && !AuthorizationLedger::ACTIONS.include?(action)
      refuse("unknown authorization action #{action.inspect} (expected #{AuthorizationLedger::ACTIONS.join(', ')})")
    end
    opts[:gates] << { "name" => name, "action" => action }
  when "--branch"
    # Everything after the second colon is the waiting text; it may contain colons.
    name, state, waiting = value.split(":", 3)
    unless name.to_s.match?(CompletionGuard::BRANCH_NAME_PATTERN)
      refuse("branch name #{name.inspect} must match #{CompletionGuard::BRANCH_NAME_PATTERN.inspect}")
    end
    case state
    when "ready"
      refuse("--branch #{name}:ready takes no waiting text") unless waiting.nil?
      opts[:branches] << { "name" => name, "state" => "ready", "waiting_for" => [] }
    when "blocked"
      refuse("--branch #{name}:blocked needs waiting text: NAME:blocked:TEXT") if waiting.to_s.strip.empty?
      opts[:branches] << { "name" => name, "state" => "blocked", "waiting_for" => [waiting.strip] }
    else
      refuse("--branch takes NAME:ready or NAME:blocked:TEXT, got #{value.inspect}")
    end
  else
    refuse("unknown flag #{flag.inspect}")
  end
end

refuse("--actor and --reason are required") if opts[:actor].to_s.empty? || opts[:reason].to_s.empty?
declares = !(opts[:gates].empty? && opts[:branches].empty?)
if opts.key?(:no_new_gates)
  refuse("--no-new-gates needs a reason") if opts[:no_new_gates].empty?
  refuse("pass either --gate/--branch or --no-new-gates, not both") if declares
elsif !declares
  refuse("a revision must declare --gate/--branch or say --no-new-gates WHY")
end
gate_names = opts[:gates].map { |gate| gate["name"] }
branch_names = opts[:branches].map { |branch| branch["name"] }
refuse("gate declared twice in one revision") unless gate_names.uniq.size == gate_names.size
refuse("branch declared twice in one revision") unless branch_names.uniq.size == branch_names.size

runs_dir = ENV["AI_OFFICE_RUNS_DIR"].to_s.empty? ? File.expand_path("../runs", __dir__) : ENV["AI_OFFICE_RUNS_DIR"]
task_dir = File.join(runs_dir, task_id)
status_path = File.join(task_dir, "status.yaml")
refuse("missing #{status_path}", 3) unless File.file?(status_path)

# Same critical section as every other status writer: per-task lock, then the
# ownership fence inside it. Everything below is checked before anything changes.
lock = File.open(File.join(task_dir, ".lock"), File::RDWR | File::CREAT, 0o644)
lock.flock(File::LOCK_EX)
TaskOwnership.fence!(task_dir)

# ONE clock read: every record and history row of this revision carries it.
now = begin
  AuthorizationLedger.format_time(AuthorizationLedger.now_utc)
rescue AuthorizationLedger::Error => e
  refuse(e.message)
end

status = begin
  YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true)
rescue StandardError => e
  refuse("cannot read status.yaml: #{e.message}", 3)
end
refuse("status.yaml must be a map for #{task_id}", 3) unless status.is_a?(Hash) && status["task_id"] == task_id
refuse("status.yaml completion_gates must be a map", 3) if status.key?("completion_gates") && !status["completion_gates"].is_a?(Hash)
if !opts[:branches].empty? || status.key?("branches")
  branch_error = CompletionGuard.branch_state_error(status)
  refuse(branch_error, 3) if branch_error
end
revision_errors = PlanRevisions.stored_errors(status, "status.yaml")
refuse("cannot build on malformed revisions: #{revision_errors.first}", 3) unless revision_errors.empty?

phase = status["phase"].to_s
refuse("cannot revise the plan of a #{phase} task") if FINISHED_PHASES.include?(phase)

revisions = status["revisions"] || []
gates = status["completion_gates"] || {}
content = PlanRevisions.content(kind: kind, actor: opts[:actor], reason: opts[:reason],
                                gates: gate_names, branches: branch_names, no_new_gates: opts[:no_new_gates])
# A retry after a crash between "wrote" and "printed" must not fail on
# "already declared": checked before any gate or branch is created. Bindings
# are compared too, because the entry stores gate names only.
same_bindings = opts[:gates].all? do |gate|
  gates[gate["name"]].is_a?(Hash) && gates[gate["name"]]["requires_authorization"] == gate["action"]
end
if same_bindings && PlanRevisions.same_content?(revisions.last, content)
  puts "plan revision #{revisions.last['id']} already recorded"
  exit 0
end

if !opts[:branches].empty? && !BranchProjection::UPDATABLE_PHASES.include?(phase)
  refuse("branches cannot be declared on a #{phase} task")
end
taken = gate_names.select { |name| gates.key?(name) }
refuse("gate(s) already declared: #{taken.join(', ')}; resolve them with update-completion-gate.rb") unless taken.empty?
existing_branches = status["branches"] || {}
taken = branch_names.select { |name| existing_branches.key?(name) }
refuse("branch(es) already declared: #{taken.join(', ')}; update them with update-task-branch.rb") unless taken.empty?

# Build. Key insertion order matches the existing writers run in sequence.
gates = (status["completion_gates"] ||= {}) unless opts[:gates].empty?
branches = (status["branches"] ||= {}) unless opts[:branches].empty?
status["updated_at"] = Date.today.to_s
status["history"] = [] unless status["history"].is_a?(Array)
opts[:gates].each do |gate|
  gates[gate["name"]] = CompletionGuard.gate_record(status: "pending", actor: opts[:actor], reason: opts[:reason],
                                                    updated_at: now, requires_authorization: gate["action"])
  status["history"] << CompletionGuard.gate_history_row(gate["name"], "absent", "pending",
                                                        actor: opts[:actor], reason: opts[:reason], at: now)
end
opts[:branches].each do |branch|
  branches[branch["name"]] = CompletionGuard.branch_record(state: branch["state"], actor: opts[:actor], reason: opts[:reason],
                                                           updated_at: now, waiting_for: branch["waiting_for"])
  old_phase = status["phase"]
  BranchProjection.apply!(status)
  status["history"] << CompletionGuard.branch_history_row(
    branch["name"], from: "declared", to: branch["state"], old_phase: old_phase, new_phase: status["phase"],
    actor: opts[:actor], reason: opts[:reason], at: now
  )
end
id = PlanRevisions.next_id(revisions)
status["revisions"] = revisions + [PlanRevisions.build_entry(id: id, at: now, content: content)]
status["history"] << {
  "phase" => "plan revision #{id}: #{kind}",
  "agent" => CompletionGuard.event_agent(opts[:actor]),
  "reason" => opts[:reason],
  "at" => now
}

tmp = "#{status_path}.tmp.#{$$}"
begin
  File.write(tmp, YAML.dump(status))
  File.rename(tmp, status_path)
rescue StandardError => e
  File.delete(tmp) if File.exist?(tmp)
  refuse("cannot save status.yaml: #{e.message}", 3)
end

effects = opts.key?(:no_new_gates) ? "no_new_gates" : "gates=#{gate_names.join(',')} branches=#{branch_names.join(',')}"
CompletionGuard.append_meta_event!(task_dir, type: "plan_revised", agent: CompletionGuard.event_agent(opts[:actor]),
                                   details: "revision=#{id} kind=#{kind} #{effects} task_phase=#{status['phase']}")
puts "plan revision #{id}: #{kind} (task #{status['phase']})"
```

- [ ] **Step 4: Run the suite**

Run: `bash tests/integration/plan-revisions.sh`
Expected: `[PASS] plan-revisions: plan revision record (#28 Phase 2A)`

If section G fails, read the diff. A difference in key order or in a history row means the writer's build order has drifted from the existing writers'. Fix the writer, never the test.

- [ ] **Step 5: Prove three key behaviours bite (the evidence is for the PR, not to be kept)**

Run each mutation, confirm the named failure, then revert with `git checkout scripts/revise-task-plan.rb`:
1. Comment out `refuse("a revision must declare --gate/--branch or say --no-new-gates WHY")` → expect `[FAIL] X bare revision exit`.
2. Replace `same_bindings && ` with an empty string → expect `[FAIL] X same revision, different binding exit`.
3. Change `PlanRevisions.next_id(revisions)` to `PlanRevisions.format_id(revisions.size + 1)` → expect `[FAIL] I id crosses 999` (the seed holds two entries, `rev-998` and `rev-999`, so a count-based id would produce `rev-003`).

- [ ] **Step 6: Commit**

```bash
git -C /Users/earth/Documents/GitHub/ai-dev-office/.claude/worktrees/issue-28-2a-impl add scripts/revise-task-plan.rb tests/integration/plan-revisions.sh
git -C /Users/earth/Documents/GitHub/ai-dev-office/.claude/worktrees/issue-28-2a-impl commit -m "feat(office): governed plan revision writer (#28 Phase 2A)

revise-task-plan.rb records a revision and, in the same locked, fenced,
single write, declares the gates and branches it implies or records why
there are none. A bare revision is refused.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Docs and full regression

**Files:**
- Create: `docs/plan-revisions.md`
- Modify: `docs/task-transition-contract.md` (one bullet, directly after the "Failure classification (issue #28 Phase 1D)" bullet)

**Interfaces:**
- Consumes: the CLI and record from Tasks 2–3.
- Produces: documentation only.

- [ ] **Step 1: Write `docs/plan-revisions.md`**

````markdown
# Plan revisions (Issue #28, Phase 2A)

When a task's plan or scope changes mid-run, record it as a **revision**. A
revision is an append-only entry in `status.yaml` that must, in the same
write, either declare the completion gates and branches the change implies or
say why it implies none. It cannot be recorded while silently skipping that
question.

A revision authorizes nothing (`authorization.yaml`), decides nothing
(`decision.yaml`) and adds no completion rule. The gates and branches it
declares are ordinary ones: the existing completion guard, authorization
binding and branch rules give them their teeth.

## Recording one

```bash
# scope grew into production data work: declare the bound gate now
ruby scripts/revise-task-plan.rb TASK-VS-010 scope_expanded --actor dev \
  --reason "operator chose to backfill rows written with the old timezone" \
  --gate production_backfill:production_backfill

# the plan split into an executable and a decision-blocked part
ruby scripts/revise-task-plan.rb TASK-VS-004 plan_changed --actor pm \
  --reason "wave 2 waits on the fairness policy" \
  --branch wave_1:ready --branch "wave_2:blocked:operator: fairness policy A/B/C"

# the plan changed but the completion contract did not
ruby scripts/revise-task-plan.rb TASK-VS-006 plan_changed --actor dev \
  --reason "second root cause found in staging" \
  --no-new-gates "same files and the same deploy path as the existing gates"
```

- `kind`: `scope_expanded`, `scope_narrowed`, `plan_changed` or `acceptance_changed`. It is a label only; no behaviour depends on it.
- `--gate NAME` declares an unbound gate. `--gate NAME:ACTION` binds it to an authorization action (`deploy_staging deploy_production production_data_mutation production_backfill live_load external_side_effect`).
- `--branch NAME:ready` or `--branch NAME:blocked:TEXT`. Everything after the second colon is the single `waiting_for` entry; add more waits with `update-task-branch.rb`.
- You must pass either at least one `--gate`/`--branch` or `--no-new-gates WHY`, and not both.
- Narrowing is `scope_narrowed --no-new-gates WHY`, followed by `update-completion-gate.rb … na` / `update-task-branch.rb … na` for whatever no longer applies. A revision never resolves a gate or a branch.
- Exits: `0` recorded, or the identical last revision is already recorded (safe to retry); `2` usage error or refusal (finished task, name already declared, unknown kind/action); `3` unreadable or malformed state; `9` ownership fence.

## What is stored

```yaml
revisions:
  - id: rev-001                 # numeric order, never string order; grows past rev-999
    at: "2026-09-28T08:00:00Z"
    kind: scope_expanded
    actor: dev
    reason: "Operator chose to ship a backfill for rows written with the old timezone"
    effects:
      gates_declared: [production_backfill]
      branches_declared: []
```

The writer also appends status history rows: one per gate and branch, in the existing writers' formats, then `plan revision rev-NNN: <kind>`. It appends a `plan_revised` event to the local `meta.yaml`, which is an informational mirror only. The validator requires that every name in `effects` still exists in `completion_gates` / `branches`.

## Limits

- `actor` and `reason` are unverified free text; `status.yaml` can be hand-edited. Same trust level as gates and branches.
- Nothing detects that the scope changed. A revision exists only if someone records it.
- A recorded revision counts as meaningful activity for the execution-budget no-progress guard.
- Declaring a gate with `update-completion-gate.rb` after work began is still allowed without a revision (deferred; see the spec).

Spec: [`superpowers/specs/2026-10-02-plan-revisions-design.md`](superpowers/specs/2026-10-02-plan-revisions-design.md).
````

- [ ] **Step 2: Add the transition-contract bullet**

In `docs/task-transition-contract.md`, directly after the bullet that starts with `- Failure classification (issue #28 Phase 1D)`:

```markdown
- `revisions` (issue #28 Phase 2A, optional) — append-only record of plan/scope changes, written only by `scripts/revise-task-plan.rb`. Each entry declares the gates/branches the change added (`effects`, created in the same write) or records `no_new_gates` with a reason. It adds no `done` rule; the gates and branches it declared are enforced by the existing guards. See [`plan-revisions.md`](plan-revisions.md).
```

- [ ] **Step 3: Full regression**

Run from the worktree root:

```bash
for t in plan-revisions completion-gates partial-branches authorization-ledger failure-recovery schema-validator-parity; do bash "tests/integration/$t.sh" > "/tmp/2a-$t.log" 2>&1 && echo "ok $t" || echo "FAIL $t"; done
```

Expected: six `ok` lines. Then run `bash tests/integration/authorization-dispatch.sh > /tmp/2a-dispatch.log 2>&1` in the background (about 6 minutes) and confirm its final `[PASS]` line. Any failure in a pre-existing suite is a regression from Task 1: fix the code, never the test.

Validate the real runs that the replay used. They must be unaffected:

```bash
for t in TASK-VS-003 TASK-VS-004 TASK-VS-006 TASK-VS-008 TASK-VS-010; do ruby validate-yaml.rb "$t" >/dev/null && echo "ok $t" || echo "FAIL $t"; done
```

Expected: five `ok` lines.

- [ ] **Step 4: Commit**

```bash
git -C /Users/earth/Documents/GitHub/ai-dev-office/.claude/worktrees/issue-28-2a-impl add docs/plan-revisions.md docs/task-transition-contract.md
git -C /Users/earth/Documents/GitHub/ai-dev-office/.claude/worktrees/issue-28-2a-impl commit -m "docs(office): plan revisions (#28 Phase 2A)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Spec coverage

| Spec item | Where |
|---|---|
| Design 1 data shape, id/at/kind/actor/reason, exactly one of effects/no_new_gates | T2 `stored_errors`, section V |
| Design 2 CLI, `NAME:ACTION`, branch text after the second colon, bare/both refused | T3 parse, sections R and X |
| One transaction under lock + fence, one clock read, single write, any refusal writes nothing | T3 writer, sections X and C |
| Declared gate = ordinary gate, same record and history row | T1 helpers, T3 section G |
| Refusals: finished task, existing name, unknown kind/action, malformed name, blocked without text; exit 3 states; exit 9 | T3 sections X and C |
| Idempotency of the last revision only, checked before creation | T3 section I (plus decision 2) |
| `plan_revised` meta mirror | T3 sections R (VS-010 and VS-006) |
| Shared helpers, existing writers byte-identical | T1 section W |
| Design 3 teeth from existing guards (1A/1B.1/1C) | T3 section R (`done` refused, then allowed once the bound gate passes with a grant) |
| Design 4 validator rules, schema, parity | T2 |
| Tests: VS-010/004/006/003 shapes, numeric ids past 999, concurrency, sync copy | T3 sections R, I, C, S |
| Rollback: declared gates keep protecting after a revert | T3 section S (plus decision 5) |
| Docs `plan-revisions.md`, `task-transition-contract.md` | T4 |

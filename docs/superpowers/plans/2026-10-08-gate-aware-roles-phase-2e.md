# Phase 2E Gate-Aware Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the roles to use completion gates.
- PM plans gates in `pm-output.yaml`, and syncing the PM output declares them add-only, refusing a conflicting plan with exit 6.
- Every role contract carries a "Completion gates" rule.
- The dispatched prompt shows a `--- COMPLETION GATES ---` block.

**Architecture:** Five tasks, each building on the previous:
1. **`CompletionGuard`** gets the per-change history-row and meta-detail helpers, which the writer now uses with byte-identical output. It also gets `plan_gate_errors` (plan shape) and `reconcile_gate_plan` (add-only, pure).
2. **The validator, schema and parity** learn the PM field.
3. **`sync-status-from-output.rb`** applies the plan inside its existing critical section and single write. `run-agent.sh` routes the new exit 6 to `validation_failed`.
4. **The 2D renderer** moves to `scripts/gate-status-text.rb`. `run-agent.sh status` and the new prompt block both use it.
5. **The role contracts and docs** are updated.

**Tech Stack:** Ruby 2.6.10 stdlib, bash (`run-agent.sh`), bash integration tests.

**Spec:** [`docs/superpowers/specs/2026-10-08-gate-aware-roles-phase-2e-design.md`](../specs/2026-10-08-gate-aware-roles-phase-2e-design.md) (PR #47). Read it before any task; this plan argues from it.

**Base:** `main` at e5966448 (1A–1D, 2A–2D merged). Nothing else needs to merge first.

## Global Constraints

- **Ruby 2.6.10:** no endless method definitions, no `Hash#except`, no pattern matching, no numbered block params.
- **Bash tests:** never put backticks inside double-quoted bash strings in tests (they execute). Never pipe into `grep -q` under `set -o pipefail`; read from a file or a here-string instead.
- **The plan field.** `completion_gates` in PM output is an optional list of maps.
  - Each entry has `name` (the gate-name grammar) and a non-empty `reason`.
  - Optional keys: `after` (non-empty, no duplicates, not the gate itself), `requires_authorization` (one of the six actions) and `requires_record` (exactly `true`).
  - No other keys, and no duplicate names.
- **Sync rules.**
  - Only the PM's output declares gates.
  - Reconciliation is add-only:
    - a new gate is declared;
    - an equal gate is a no-op;
    - a pending gate may gain `after` names and `requires_record`.
  - Any change or removal, an addition to a non-pending gate, an unknown `after` name, or a cycle refuses the whole sync with **exit 6**, and nothing is written.
  - A malformed plan reaching the sync is malformed output (**exit 3**).
- **Same bytes as the writer.** Declarations and additions write the same records, history rows and `completion_gate_updated` meta details as `update-completion-gate.rb declare` / `depend` / `require-record`. The writer's own output stays byte-identical, pinned by the 2A section W golden and the 2B/2C/2D suites.
- **Prompt block.** `--- COMPLETION GATES ---` follows `--- STATUS ---` only for a task with `completion_gates` or `revisions`. Everything after the role contract is byte-identical for a gateless task. The renderer never fails a dispatch.
- **ASCII and heredocs.** Code added to `run-agent.sh` is ASCII only. Patch scripts use plain `<<'RUBY'` heredocs, never `<<~`.
- **Tests.** Every new test is seen failing before its implementation. Never weaken, skip or delete an existing test.
- **Commits.** Commits end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push; the conductor pushes.
- **Workspace.** Work only in the implementation worktree `/Users/earth/Documents/GitHub/ai-dev-office/.claude/worktrees/issue-28-2e-impl` (branch `feat/issue-28-2e-gate-aware-roles`). Use absolute paths. Never touch the main checkout (another session owns it).

## Decisions taken while proving this plan (raise them in the PR; none changes the design)

1. **The prompt's byte-identity claim is narrower than the spec's.** The dispatched prompt embeds the role contract (`agents/<role>.md`), which 2E changes on purpose. The precise claim is that everything from `--- AI CONTEXT INDEX ---` onward is byte-identical for a gateless task. A golden pins it; it was captured from the unmodified main with paths normalized.
2. **Schema placement.** `pm-output.schema.yaml` is `allOf: task.schema.yaml`, and `task.schema.yaml` has `additionalProperties: false`. So `completion_gates` is documented in `task.schema.yaml` (the PM blueprint schema), and the parity test reads it there.
3. **The exit-6 route reason.** The route reason reads `gate plan conflicts with status.yaml (see the sync message above)`. The sync's own stderr names the gate and the conflict, and it appears in the run log directly above. Capturing stderr into the reason would need a change to the sync call.
4. **The writer refuses state, the plan is malformed output.** A non-map stored `completion_gates` gives exit 6 (the plan cannot be applied). A malformed plan reaching the sync directly gives exit 3, like any malformed output. The PM validator normally catches the latter first.
5. **Gate timestamps.** Gate timestamps come from `AuthorizationLedger.now_utc`, so the test hook works, with a `Time.now` fallback if the hook is misused. The transition's own history row keeps its existing clock.
6. **Contract wording.** Role contracts call it "the `COMPLETION GATES` block", without the dashed marker. The contract is part of the prompt and must not look like the block. Tests locate the block after `--- STATUS ---`.
7. **How dispatches are tested.**
   - Prompts are captured through the interactive `cursor` runner, which is absent from `PATH`. It writes `.cursor-prompt.md` and stops.
   - The exit-6 route is exercised through a stub `codex`, a non-interactive runner that copies a prepared PM output into place, so the driver syncs it.
   - Both run against a temporary `AI_OFFICE_RUNS_DIR`.
8. **Cycles are checked twice.** The PM validator checks cycles among the listed gates; the sync checks them across the plan and `status.yaml` (`ordering_errors` on the result).
9. **Proof.** On 2026-10-08 every code block here was applied, task by task, to a scratch worktree at main e5966448. Each "verify it fails" step failed as written, and each "passes" step passed.
   - **Mutations:** five were each caught:
     - the after-drop conflict removed;
     - sync meta events dropped;
     - the exit-6 route disabled;
     - the prompt block left out of the prompt;
     - the PM-field validation unwired.
   - **Regression:** all 53 integration suites were run; 51 pass and 2 fail, `event-gateway` (M3: a trusted triage event dispatches as `dispatch_failed`) and `task-input-integrity` (T10: one task validates differently from its pre-#22 hash). Both fail identically on unmodified main e5966448, so they are pre-existing and not caused by 2E. The new `pm-gate-plan` suite passes, and so do `gate-status`, `gate-records`, `gate-ordering`, `plan-revisions`, `completion-gates`, `authorization-ledger`, `authorization-dispatch`, `context-provider` and `schema-validator-parity`. TASK-VS-003/004/006/008/010 validate.

## Review Focus

1. An empty plan (`completion_gates: []`) validates and declares nothing. → Task 3 (RF).
2. An `after` naming a gate listed later in the same plan applies. → Task 3 (RF).
3. Re-syncing an unchanged plan after one of its gates passed is not a conflict, and the passed gate is untouched. → Task 3 (RF).
4. A non-PM output carrying `completion_gates` declares nothing. → Task 3 (RF).
5. After a refused plan (exit 6), a corrected plan applies, because nothing was written by the refusal. → Task 3 (RF).

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `scripts/completion-guard.rb` | `gate_after_change`, `gate_requires_record_change`, `gate_transition_details`, `PLAN_GATE_KEYS`, `plan_gate_errors`, `reconcile_gate_plan` | 1 |
| `scripts/update-completion-gate.rb` | uses the change helpers (same bytes) | 1 |
| `validate-yaml.rb` | `validate_pm_output` checks `completion_gates` | 2 |
| `schemas/task.schema.yaml` | the `completion_gates` property | 2 |
| `tests/integration/schema-validator-parity.sh` | pins the plan keys and the action enum | 2 |
| `scripts/sync-status-from-output.rb` | applies the PM plan; exit 6 | 3 |
| `run-agent.sh` | the exit-6 route (T3); the prompt block and the `status` heredoc using `GateStatusText` (T4) | 3, 4 |
| `scripts/gate-status-text.rb` | new: the 2D text renderer, moved, plus a script entry for the prompt | 4 |
| `agents/{pm,dev,dev-2,devops,reviewer}.md` | the "Completion gates" rule; PM's contract example | 5 |
| `docs/completion-gates.md`, `docs/task-transition-contract.md` | the plan, the sync rules, exit 6 | 5 |
| `tests/integration/pm-gate-plan.sh` | new suite: sections U (T1), V (T2), S and D (T3), P (T4), R (T5) | 1–5 |

The suite is one file built in sections. **Every task inserts its block(s) immediately before the final line** `echo "[PASS] pm-gate-plan: gate-aware roles (#28 Phase 2E)"`, using a UTF-8 Ruby script (`# encoding: utf-8`), because the blocks contain em dashes. Run it with `bash tests/integration/pm-gate-plan.sh` from the worktree root. It takes about a minute, mostly for the dispatches in sections D and P.

Patch steps are small Ruby scripts. Each `rep!` / `sub!` is one exact old → new replacement that aborts if the old text is missing. Save each to the session scratchpad (never inside the repo) and run it from the worktree root.

---

### Task 1: Shared change helpers, the plan check and the add-only reconcile

**Files:**
- Modify: `scripts/completion-guard.rb` (new methods directly before the `# Phase 2D: a read-only view of a task's gates` comment)
- Modify: `scripts/update-completion-gate.rb` (the `depend` / `require-record` / transition history rows and meta details)
- Create: `tests/integration/pm-gate-plan.sh`

**Interfaces:**
- Consumes: `gate_record`, `gate_history_row`, `gate_after`, `ordering_errors`, `event_agent`, `GATE_NAME_PATTERN`, `AuthorizationLedger::ACTIONS`.
- Produces (`module_function` on `CompletionGuard`):
  - `gate_after_change(gate_name, added, actor:, reason:, at:) -> [history_row, meta_details]`
  - `gate_requires_record_change(gate_name, actor:, reason:, at:) -> [history_row, meta_details]`
  - `gate_transition_details(gate_name, old_status, new_status, actor) -> String`
  - `PLAN_GATE_KEYS` (`%w[name reason after requires_authorization requires_record]`)
  - `plan_gate_errors(plan) -> Array<String>`, with messages `completion_gates must be a list of gate plans`, `completion_gates[i] …`, `completion_gates lists gate X twice`, and the `ordering_errors` cycle message.
  - `reconcile_gate_plan(gates, plan, actor:, at:) -> [gates_copy, changes, conflict]`, where `changes` are `[history_row, meta_details]` pairs and `conflict` is nil or one of:
    - `gate X: the plan changes requires_authorization (… -> …)`
    - `gate X: the plan drops after …`
    - `gate X: the plan drops requires_record`
    - `gate X: the plan adds to a gate that is <status>`
    - `gate X is not a map`
    - the first `ordering_errors` message

- [ ] **Step 1: Create the suite (header, section U, the PASS line)**

Create `tests/integration/pm-gate-plan.sh` (mode 755):

````bash
#!/usr/bin/env bash
set -euo pipefail

# Issue #28 Phase 2E — gate-aware roles.
#
# PM declares gates in pm-output.yaml (completion_gates); syncing the PM output
# declares them in status.yaml through the writer's record construction,
# add-only, refusing a conflicting plan (exit 6, routed to validation_failed).
# Role contracts carry a Completion gates rule and the dispatched prompt shows a
# COMPLETION GATES block. Sections: U shared helpers, V the PM output field,
# S the sync, D the run-agent.sh dispatch (exit 6 routing, prompt block),
# R the role contracts.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS="$(mktemp -d)"
trap 'rm -rf "$RUNS"' EXIT
export AI_OFFICE_RUNS_DIR="$RUNS"
unset AI_DEV_OFFICE_OWNERSHIP_EPOCH AI_DEV_OFFICE_RUN_ID AI_OFFICE_NOW
GATE="$ROOT/scripts/update-completion-gate.rb"
AUTHZ="$ROOT/scripts/record-authorization.rb"
FORCE="$ROOT/scripts/force-status-route.rb"
OWN="$ROOT/scripts/task-ownership.rb"
VALIDATOR="$ROOT/validate-yaml.rb"
SYNC="$ROOT/scripts/sync-status-from-output.rb"
RUN_AGENT="$ROOT/run-agent.sh"

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
puts value.nil? ? "" : (value.is_a?(Array) ? value.join(",") : value)
RUBY
}
# task <TASK_ID> [phase] — a minimal governed task.
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
gate() { ruby "$GATE" "$@"; }
force_done() { ruby "$FORCE" "$1" "$RUNS/$1/status.yaml" 2026-10-08 done done reviewer "accept" >"$RUNS/force.log" 2>&1; }
validate() { ruby "$VALIDATOR" "$1" >"$RUNS/validate.log" 2>&1; }
# set_gate <status.yaml> <gate> <ruby hash literal> — hand-edit one gate record (stored-state cases).
set_gate() {
  ruby -ryaml -rdate -e 'p = ARGV[0]; s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time])
    (s["completion_gates"] ||= {})[ARGV[1]] = eval(ARGV[2]); File.write(p, YAML.dump(s))' "$1" "$2" "$3"
}
# expect_refusal <exit> <label> <TASK_ID> <gate writer args...> — exit code matches and nothing is written.
expect_refusal() {
  local code="$1" label="$2" task_id="$3"; shift 3
  local status="$RUNS/$task_id/status.yaml"
  cp "$status" "$RUNS/before.yaml"
  rc=0; ruby "$GATE" "$task_id" "$@" >/dev/null 2>"$RUNS/refusal.log" || rc=$?
  assert_eq "$rc" "$code" "$label exit ($(cat "$RUNS/refusal.log"))"
  cmp -s "$status" "$RUNS/before.yaml" || fail "$label wrote status.yaml"
}

# --- U: shared helpers ---
ruby - "$ROOT" <<'RUBY'
require File.join(ARGV[0], "scripts", "completion-guard")
G = CompletionGuard
def check(label, actual, expected)
  abort "[FAIL] U #{label}: expected #{expected.inspect}, got #{actual.inspect}" unless actual == expected
end
T = "2026-10-08T01:00:00Z"
check "after change", G.gate_after_change("b", %w[a c], actor: "pm", reason: "r", at: T),
      [{ "phase" => "gate b: after += a,c", "agent" => "pm", "reason" => "r", "at" => T }, "gate=b after+=a,c actor=pm"]
check "record change", G.gate_requires_record_change("b", actor: "pm", reason: "r", at: T),
      [{ "phase" => "gate b: requires_record", "agent" => "pm", "reason" => "r", "at" => T }, "gate=b requires_record actor=pm"]
check "transition details", G.gate_transition_details("b", "absent", "pending", "pm"), "gate=b absent->pending actor=pm"

check "valid plan", G.plan_gate_errors([{ "name" => "a", "reason" => "r" }, { "name" => "b", "reason" => "r", "after" => ["a"], "requires_record" => true, "requires_authorization" => "deploy_staging" }]), []
check "plan not a list", G.plan_gate_errors({}), ["completion_gates must be a list of gate plans"]
check "entry not a map", G.plan_gate_errors(["a"]), ["completion_gates[0] must be a map"]
check "bad name", G.plan_gate_errors([{ "name" => "Bad", "reason" => "r" }]), ["completion_gates[0].name must match /\\A[a-z][a-z0-9_]*\\z/"]
check "no reason", G.plan_gate_errors([{ "name" => "a" }]), ["completion_gates[0].reason must be a non-empty string"]
check "unknown key", G.plan_gate_errors([{ "name" => "a", "reason" => "r", "status" => "pass" }]), ["completion_gates[0] has unknown field(s): status"]
check "duplicate name", G.plan_gate_errors([{ "name" => "a", "reason" => "r" }, { "name" => "a", "reason" => "r" }]), ["completion_gates lists gate a twice"]
check "after empty", G.plan_gate_errors([{ "name" => "a", "reason" => "r", "after" => [] }]), ["completion_gates[0].after must be a non-empty list of gate names"]
check "after self", G.plan_gate_errors([{ "name" => "a", "reason" => "r", "after" => ["a"] }]), ["completion_gates[0].after names the gate itself"]
check "after twice", G.plan_gate_errors([{ "name" => "a", "reason" => "r", "after" => %w[b b] }]), ["completion_gates[0].after lists a gate twice"]
check "bad action", G.plan_gate_errors([{ "name" => "a", "reason" => "r", "requires_authorization" => "deploy_prod" }]),
      ["completion_gates[0].requires_authorization must be one of #{AuthorizationLedger::ACTIONS.join(', ')}"]
check "record not true", G.plan_gate_errors([{ "name" => "a", "reason" => "r", "requires_record" => false }]), ["completion_gates[0].requires_record must be true"]
check "plan cycle", G.plan_gate_errors([{ "name" => "a", "reason" => "r", "after" => ["b"] }, { "name" => "b", "reason" => "r", "after" => ["a"] }]),
      ["completion_gates.a.after creates a cycle through b"]
check "after naming a stored gate is not a plan error", G.plan_gate_errors([{ "name" => "b", "reason" => "r", "after" => ["stored"] }]), []

stored = { "a" => { "status" => "pass", "actor" => "dev", "reason" => "done", "updated_at" => T, "evidence_refs" => [] } }
plan = [{ "name" => "a", "reason" => "r" }, { "name" => "b", "reason" => "build", "after" => ["a"], "requires_record" => true }]
gates, changes, conflict = G.reconcile_gate_plan(stored, plan, actor: "pm", at: T)
check "declare: conflict", conflict, nil
check "declare: new gate", gates["b"], { "status" => "pending", "actor" => "pm", "reason" => "build", "updated_at" => T, "evidence_refs" => [], "after" => ["a"], "requires_record" => true }
check "declare: stored untouched", gates["a"], stored["a"]
check "declare: rows", changes.map { |row, _| row["phase"] }, ["gate b: absent -> pending"]
check "declare: details", changes.map { |_, details| details }, ["gate=b absent->pending actor=pm"]
check "declare: input not mutated", stored.keys, ["a"]
_, changes, conflict = G.reconcile_gate_plan(gates, plan, actor: "pm", at: T)
check "same plan is a no-op", [changes, conflict], [[], nil]
grown = [{ "name" => "a", "reason" => "r" }, { "name" => "c", "reason" => "c" }, { "name" => "b", "reason" => "more", "after" => %w[a c], "requires_record" => true }]
g2, changes, conflict = G.reconcile_gate_plan(gates, grown, actor: "pm", at: T)
check "add: rows", [conflict, changes.map { |row, _| row["phase"] }], [nil, ["gate c: absent -> pending", "gate b: after += c"]]
check "add: after appended", g2["b"]["after"], %w[a c]
pending_plain = { "d" => { "status" => "pending", "actor" => "pm", "reason" => "d", "updated_at" => T, "evidence_refs" => [] } }
g3, changes, conflict = G.reconcile_gate_plan(pending_plain, [{ "name" => "d", "reason" => "needs a record", "requires_record" => true }], actor: "pm", at: T)
check "add record", [conflict, changes.map { |row, _| row["phase"] }, g3["d"]["requires_record"]], [nil, ["gate d: requires_record"], true]
def conflict_of(gates, plan)
  CompletionGuard.reconcile_gate_plan(gates, plan, actor: "pm", at: T)[2]
end
check "conflict: binding changed", conflict_of(gates, [{ "name" => "b", "reason" => "x", "after" => ["a"], "requires_record" => true, "requires_authorization" => "deploy_staging" }]),
      "gate b: the plan changes requires_authorization (nil -> \"deploy_staging\")"
check "conflict: after dropped", conflict_of(gates, [{ "name" => "b", "reason" => "x", "requires_record" => true }]), "gate b: the plan drops after a"
check "conflict: record dropped", conflict_of(gates, [{ "name" => "b", "reason" => "x", "after" => ["a"] }]), "gate b: the plan drops requires_record"
check "conflict: adding to a passed gate", conflict_of(gates, [{ "name" => "a", "reason" => "x", "requires_record" => true }]), "gate a: the plan adds to a gate that is pass"
check "conflict: unknown after", conflict_of(gates, [{ "name" => "e", "reason" => "x", "after" => ["zz"] }]), "completion_gates.e.after names zz, which is not a declared gate"
check "conflict: cycle across plan and status", conflict_of(gates, [{ "name" => "a", "reason" => "x" }, { "name" => "f", "reason" => "x", "after" => ["b"] }, { "name" => "b", "reason" => "x", "after" => %w[a f], "requires_record" => true }]),
      "completion_gates.b.after creates a cycle through f"
check "conflict: stored gate not a map", conflict_of({ "a" => "oops" }, [{ "name" => "a", "reason" => "x" }]), "gate a is not a map"
RUBY

echo "[PASS] pm-gate-plan: gate-aware roles (#28 Phase 2E)"
````

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/pm-gate-plan.sh`
Expected: FAIL with `undefined method 'gate_after_change' for CompletionGuard:Module (NoMethodError)`.

- [ ] **Step 3: Patch `CompletionGuard` and the writer**

Save as `2e-guard-patch.rb` in the scratchpad, then run `ruby <scratchpad>/2e-guard-patch.rb scripts/completion-guard.rb`:

```ruby
# encoding: utf-8
path = ARGV[0]
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  s.sub!(old) { new } or abort "no match: #{old[0, 70].inspect}"
end
# Plain heredoc: the inserted methods keep their two-space indent.
methods = <<'RUBY'

  # Phase 2E: the history row and meta-event details for each gate change.
  # Shared by update-completion-gate.rb and the PM gate-plan sync, so both
  # record a change with the same bytes.
  def gate_after_change(gate_name, added, actor:, reason:, at:)
    [
      { "phase" => "gate #{gate_name}: after += #{added.join(',')}", "agent" => event_agent(actor), "reason" => reason, "at" => at },
      "gate=#{gate_name} after+=#{added.join(',')} actor=#{actor}"
    ]
  end

  def gate_requires_record_change(gate_name, actor:, reason:, at:)
    [
      { "phase" => "gate #{gate_name}: requires_record", "agent" => event_agent(actor), "reason" => reason, "at" => at },
      "gate=#{gate_name} requires_record actor=#{actor}"
    ]
  end

  def gate_transition_details(gate_name, old_status, new_status, actor)
    "gate=#{gate_name} #{old_status}->#{new_status} actor=#{actor}"
  end

  PLAN_GATE_KEYS = %w[name reason after requires_authorization requires_record].freeze

  # Phase 2E: shape problems with a PM gate plan (pm-output completion_gates),
  # shared by validate-yaml.rb and the sync. Whether an `after` name exists is a
  # sync-time question (it may name a gate already in status.yaml).
  def plan_gate_errors(plan)
    return ["completion_gates must be a list of gate plans"] unless plan.is_a?(Array)

    errors = []
    seen = {}
    plan.each_with_index do |item, index|
      label = "completion_gates[#{index}]"
      unless item.is_a?(Hash)
        errors << "#{label} must be a map"
        next
      end
      unknown = item.keys - PLAN_GATE_KEYS
      errors << "#{label} has unknown field(s): #{unknown.join(', ')}" unless unknown.empty?
      name = item["name"]
      if name.is_a?(String) && name.match?(GATE_NAME_PATTERN)
        errors << "completion_gates lists gate #{name} twice" if seen[name]
        seen[name] = true
      else
        errors << "#{label}.name must match #{GATE_NAME_PATTERN.inspect}"
      end
      errors << "#{label}.reason must be a non-empty string" unless item["reason"].is_a?(String) && !item["reason"].strip.empty?
      if item.key?("after")
        after = item["after"]
        if !(after.is_a?(Array) && !after.empty? && after.all? { |dep| dep.is_a?(String) && dep.match?(GATE_NAME_PATTERN) })
          errors << "#{label}.after must be a non-empty list of gate names"
        elsif after.uniq.size != after.size
          errors << "#{label}.after lists a gate twice"
        elsif after.include?(name)
          errors << "#{label}.after names the gate itself"
        end
      end
      if item.key?("requires_authorization") && !AuthorizationLedger::ACTIONS.include?(item["requires_authorization"])
        errors << "#{label}.requires_authorization must be one of #{AuthorizationLedger::ACTIONS.join(', ')}"
      end
      errors << "#{label}.requires_record must be true" if item.key?("requires_record") && item["requires_record"] != true
    end
    return errors unless errors.empty?

    # A cycle among the listed gates (names outside the plan are checked at sync).
    listed = plan.each_with_object({}) do |item, gates|
      inner = Array(item["after"]) & plan.map { |other| other["name"] }
      gates[item["name"]] = inner.empty? ? {} : { "after" => inner }
    end
    ordering_errors(listed)
  end

  # Phase 2E: reconcile a valid PM gate plan with the stored gates, add-only.
  # Returns [gates, changes, conflict]: the updated gate map (a copy; the input
  # is never mutated), the [history_row, meta_details] pairs to record, and the
  # first conflict message (nil when the plan applies). A gate the plan does not
  # list is left as it is.
  def reconcile_gate_plan(gates, plan, actor:, at:)
    result = Marshal.load(Marshal.dump(gates))
    changes = []
    plan.each do |item|
      name = item["name"]
      reason = item["reason"]
      wanted_after = Array(item["after"])
      wanted_binding = item["requires_authorization"]
      wanted_record = item["requires_record"] == true
      existing = result[name]
      if existing.nil?
        result[name] = gate_record(status: "pending", actor: actor, reason: reason, updated_at: at,
                                   requires_authorization: wanted_binding, after: wanted_after.empty? ? nil : wanted_after,
                                   requires_record: wanted_record ? true : nil)
        changes << [gate_history_row(name, "absent", "pending", actor: actor, reason: reason, at: at),
                    gate_transition_details(name, "absent", "pending", actor)]
        next
      end
      return [gates, [], "gate #{name} is not a map"] unless existing.is_a?(Hash)

      if existing["requires_authorization"] != wanted_binding
        return [gates, [], "gate #{name}: the plan changes requires_authorization (#{existing['requires_authorization'].inspect} -> #{wanted_binding.inspect})"]
      end
      have_after = gate_after(existing)
      removed = have_after - wanted_after
      return [gates, [], "gate #{name}: the plan drops after #{removed.join(', ')}"] unless removed.empty?
      return [gates, [], "gate #{name}: the plan drops requires_record"] if existing["requires_record"] == true && !wanted_record

      added = wanted_after - have_after
      add_record = wanted_record && existing["requires_record"] != true
      next if added.empty? && !add_record
      return [gates, [], "gate #{name}: the plan adds to a gate that is #{existing['status']}"] unless existing["status"] == "pending"

      unless added.empty?
        existing["after"] = have_after + added
        changes << gate_after_change(name, added, actor: actor, reason: reason, at: at)
      end
      if add_record
        existing["requires_record"] = true
        changes << gate_requires_record_change(name, actor: actor, reason: reason, at: at)
      end
    end
    problems = ordering_errors(result)
    return [gates, [], problems.first] unless problems.empty?

    [result, changes, nil]
  end
RUBY
anchor = "  def gate_transition_placeholder"
i = s.index("  # Phase 2D: a read-only view of a task's gates") or abort "anchor"
s = s[0...i] + methods.sub(/\A\n/, "") + "\n" + s[i..-1]
File.write(path, s)
```

Save as `2e-writer-patch.rb` in the scratchpad, then run `ruby <scratchpad>/2e-writer-patch.rb scripts/update-completion-gate.rb`:

```ruby
# encoding: utf-8
path = ARGV[0]
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  s.sub!(old) { new } or abort "no match: #{old[0, 70].inspect}"
end
rep!(s, <<'OLD', <<'NEW')
  history_row = {
    "phase" => "gate #{gate_name}: after += #{new_after.join(',')}",
    "agent" => CompletionGuard.event_agent(opts[:actor]),
    "reason" => opts[:reason],
    "at" => now
  }
  event_details = "gate=#{gate_name} after+=#{new_after.join(',')} actor=#{opts[:actor]}"
OLD
  history_row, event_details = CompletionGuard.gate_after_change(gate_name, new_after, actor: opts[:actor], reason: opts[:reason], at: now)
NEW
rep!(s, <<'OLD', <<'NEW')
  history_row = {
    "phase" => "gate #{gate_name}: requires_record",
    "agent" => CompletionGuard.event_agent(opts[:actor]),
    "reason" => opts[:reason],
    "at" => now
  }
  event_details = "gate=#{gate_name} requires_record actor=#{opts[:actor]}"
OLD
  history_row, event_details = CompletionGuard.gate_requires_record_change(gate_name, actor: opts[:actor], reason: opts[:reason], at: now)
NEW
rep!(s, %Q{  event_details = "gate=\#{gate_name} \#{old_status}->\#{new_status} actor=\#{opts[:actor]}"\n},
        %Q{  event_details = CompletionGuard.gate_transition_details(gate_name, old_status, new_status, opts[:actor])\n})
File.write(path, s)
```

- [ ] **Step 4: Run the suite and the suites that pin the writer**

Run: `bash tests/integration/pm-gate-plan.sh && bash tests/integration/plan-revisions.sh && bash tests/integration/gate-ordering.sh && bash tests/integration/gate-records.sh && bash tests/integration/gate-status.sh && bash tests/integration/completion-gates.sh && bash tests/integration/authorization-ledger.sh`
Expected: each prints its own PASS line. `gate-ordering.sh` and `gate-records.sh` pin the `depend` / `require-record` meta details.

- [ ] **Step 5: Prove the reconcile bites**

In `reconcile_gate_plan`, change `      return [gates, [], "gate #{name}: the plan drops after #{removed.join(', ')}"] unless removed.empty?` to `      nil`, using a script file (the line contains quotes). Expect `[FAIL] U conflict: after dropped`. Then restore the file.

- [ ] **Step 6: Commit**

```bash
git add scripts/completion-guard.rb scripts/update-completion-gate.rb tests/integration/pm-gate-plan.sh
git commit -m "feat(office): gate change helpers, PM plan check and add-only reconcile (#28 Phase 2E)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The `completion_gates` field in PM output

**Files:**
- Modify: `validate-yaml.rb` (the end of `validate_pm_output`)
- Modify: `schemas/task.schema.yaml` (append the `completion_gates` property)
- Modify: `tests/integration/schema-validator-parity.sh` (checks directly before `failed = false`)
- Modify: `tests/integration/pm-gate-plan.sh` (section V)

**Interfaces:**
- Consumes: `CompletionGuard.plan_gate_errors`, `PLAN_GATE_KEYS`.
- Produces: validator messages `pm-output.yaml.<plan_gate_errors message>`. Section V also defines the bash helper `pm_output <TASK_ID> [completion_gates YAML]`, which Tasks 3 and 4 use.

- [ ] **Step 1: Write section V (failing)**

Insert before the PASS line:

````bash
# --- V: the completion_gates field in PM output ---
# pm_output <TASK_ID> [completion_gates YAML] — a minimal valid PM output, optionally with a gate plan.
pm_output() {
  local file="$RUNS/$1/pm-output.yaml"
  mkdir -p "$RUNS/$1"
  cat > "$file" <<YAML
task:
  id: $1
  title: Profile statistics
  type: feature
  priority: medium
scope:
  target_services: []
description: Profile statistics endpoint
acceptance_criteria:
  - criterion: statistics are returned
plan:
  approach: implement and verify
assignment:
  primary: dev
  parallel: false
  reason: single service
summary: Plan the profile statistics work
artifacts: []
blockers: []
next_action:
  agent: dev
  reason: ready for implementation
YAML
  if [[ -n "${2:-}" ]]; then printf '%s\n' "$2" >> "$file"; fi
}
mkdir -p "$RUNS/v"
pm_output TASK-1500
validate "$RUNS/TASK-1500/pm-output.yaml" || fail "V a PM output without completion_gates no longer validates: $(cat "$RUNS/validate.log")"
pm_output TASK-1501 'completion_gates:
  - name: product_contract
    reason: contract locked with the operator
  - name: shared_lib_publication
    reason: Game and gateway consume the published contract
    after: [product_contract]
    requires_record: true
  - name: deploy
    reason: production deploy
    after: [shared_lib_publication]
    requires_authorization: deploy_production'
validate "$RUNS/TASK-1501/pm-output.yaml" || fail "V a valid gate plan was rejected: $(cat "$RUNS/validate.log")"
v_bad() { # <label> <completion_gates YAML> <message fragment>
  pm_output TASK-1502 "$2"
  if validate "$RUNS/TASK-1502/pm-output.yaml"; then fail "V $1 validated"; fi
  grep -qF "$3" "$RUNS/validate.log" || fail "V $1 message: $(cat "$RUNS/validate.log")"
}
v_bad not-a-list 'completion_gates: {}' "pm-output.yaml.completion_gates must be a list of gate plans"
v_bad bad-name 'completion_gates:
  - name: Bad
    reason: r' "pm-output.yaml.completion_gates[0].name must match"
v_bad no-reason 'completion_gates:
  - name: a' "pm-output.yaml.completion_gates[0].reason must be a non-empty string"
v_bad duplicate 'completion_gates:
  - {name: a, reason: r}
  - {name: a, reason: r}' "pm-output.yaml.completion_gates lists gate a twice"
v_bad self-after 'completion_gates:
  - {name: a, reason: r, after: [a]}' "pm-output.yaml.completion_gates[0].after names the gate itself"
v_bad cycle 'completion_gates:
  - {name: a, reason: r, after: [b]}
  - {name: b, reason: r, after: [a]}' "pm-output.yaml.completion_gates.a.after creates a cycle through b"
v_bad bad-action 'completion_gates:
  - {name: a, reason: r, requires_authorization: deploy_prod}' "pm-output.yaml.completion_gates[0].requires_authorization must be one of"
v_bad record-false 'completion_gates:
  - {name: a, reason: r, requires_record: false}' "pm-output.yaml.completion_gates[0].requires_record must be true"
v_bad unknown-key 'completion_gates:
  - {name: a, reason: r, status: pass}' "pm-output.yaml.completion_gates[0] has unknown field(s): status"
````

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/pm-gate-plan.sh`
Expected: FAIL with `[FAIL] V not-a-list validated`.

- [ ] **Step 3: Patch the validator**

Save as `2e-validator-patch.rb` in the scratchpad, then run `ruby <scratchpad>/2e-validator-patch.rb validate-yaml.rb`:

```ruby
# encoding: utf-8
path = ARGV[0]
s = File.read(path, encoding: "UTF-8")
old = <<'OLD'
  if data["next_action"].is_a?(Hash)
    expect_enum(data["next_action"]["agent"], %w[dev dev-2 free-roam], "#{label}.next_action.agent", errors)
  end
end
OLD
new = <<'NEW'
  if data["next_action"].is_a?(Hash)
    expect_enum(data["next_action"]["agent"], %w[dev dev-2 free-roam], "#{label}.next_action.agent", errors)
  end

  # Issue #28 Phase 2E: the PM's gate plan (applied by the sync, add-only).
  if data.key?("completion_gates")
    CompletionGuard.plan_gate_errors(data["completion_gates"]).each { |message| errors << "#{label}.#{message}" }
  end
end
NEW
abort "anchor count #{s.scan(old).size}" unless s.scan(old).size == 1
s.sub!(old) { new }
File.write(path, s)
```

- [ ] **Step 4: Run the suite**

Run: `bash tests/integration/pm-gate-plan.sh`
Expected: `[PASS] pm-gate-plan: gate-aware roles (#28 Phase 2E)`

- [ ] **Step 5: Add the parity checks (failing)**

In `tests/integration/schema-validator-parity.sh`, insert directly before the line `failed = false`:

```ruby
# --- PM gate plan (issue #28 Phase 2E) ------------------------------------------
plan_item = YAML.load_file("schemas/task.schema.yaml")["properties"].fetch("completion_gates")["items"]
checks << ["task.completion_gates item keys", CompletionGuard::PLAN_GATE_KEYS.sort, plan_item["properties"].keys.sort]
checks << ["task.completion_gates.requires_authorization", AuthorizationLedger::ACTIONS.sort,
           plan_item["properties"]["requires_authorization"]["enum"].sort]
# --- end PM gate plan block -----------------------------------------------------

```

Run: `bash tests/integration/schema-validator-parity.sh`
Expected: FAIL with `` in `fetch': key not found: "completion_gates" (KeyError) ``.

- [ ] **Step 6: Add the property to `schemas/task.schema.yaml`**

Append to the end of `schemas/task.schema.yaml`, as the last top-level property, after `blockers`:

```yaml
  completion_gates:
    type: array
    description: >
      Optional (issue #28, Phase 2E). The PM's gate plan. Syncing the PM output
      declares these gates in status.yaml through the gate writer's record
      construction, add-only; a plan that would change or remove a stored gate
      refuses the sync (exit 6). Whether an `after` name exists is checked at
      sync time. See docs/completion-gates.md.
    items:
      type: object
      additionalProperties: false
      required:
        - name
        - reason
      properties:
        name:
          type: string
          pattern: "^[a-z][a-z0-9_]*$"
        reason:
          type: string
          minLength: 1
        after:
          type: array
          minItems: 1
          uniqueItems: true
          items:
            type: string
            pattern: "^[a-z][a-z0-9_]*$"
        requires_authorization:
          type: string
          enum:
            - deploy_staging
            - deploy_production
            - production_data_mutation
            - production_backfill
            - live_load
            - external_side_effect
        requires_record:
          const: true
```

- [ ] **Step 7: Run parity and the suite**

Run: `bash tests/integration/schema-validator-parity.sh`
Expected: `  ok: task.completion_gates item keys (5 values agree)` and `  ok: task.completion_gates.requires_authorization (6 values agree)`, then `[PASS] schema-validator-parity: …`.

Run: `bash tests/integration/pm-gate-plan.sh`
Expected: `[PASS] pm-gate-plan: …`

- [ ] **Step 8: Prove the validator bites**

In `validate_pm_output`, change `    CompletionGuard.plan_gate_errors(data["completion_gates"]).each` to `    [].each`, and expect `[FAIL] V not-a-list validated`. Then restore the file.

- [ ] **Step 9: Commit**

```bash
git add validate-yaml.rb schemas/task.schema.yaml tests/integration/schema-validator-parity.sh tests/integration/pm-gate-plan.sh
git commit -m "feat(office): completion_gates plan in PM output (#28 Phase 2E)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The sync applies the plan; `run-agent.sh` routes exit 6

**Files:**
- Modify: `scripts/sync-status-from-output.rb`
- Modify: `run-agent.sh` (the sync result handling)
- Modify: `tests/integration/pm-gate-plan.sh` (sections S and D)

**Interfaces:**
- Consumes: `plan_gate_errors`, `reconcile_gate_plan`, `append_meta_event!`, `AuthorizationLedger.now_utc`; the `pm_output` test helper (Task 2).
- Produces:
  - **Sync exit 6** with stderr `Gate plan conflicts with status.yaml for <TASK>: <conflict>`.
  - **`run-agent.sh`** routes exit 6 to `validation_failed` and logs a meta `validation_failed` event with `reason=gate_plan_conflict`.
  - **Test helpers:** `sync_pm`, `gates_dump`, `history_phases`, `dispatch_pm` and `T0`.

- [ ] **Step 1: Write sections S (with the Review Focus cases) and D (failing)**

Insert before the PASS line, in this order. Section S:

````bash
# --- S: syncing a PM gate plan ---
T0=2026-10-08T01:00:00Z
EAR384_PLAN='completion_gates:
  - name: product_contract
    reason: contract locked with the operator
  - name: shared_lib_publication
    reason: Game and gateway consume the published contract
    after: [product_contract]
    requires_record: true
  - name: implementation_verification
    reason: Game and gateway verified against the published contract
    after: [shared_lib_publication]
  - name: authenticated_staging
    reason: authenticated smoke on staging
    after: [implementation_verification]
    requires_authorization: deploy_staging'
# sync_pm <TASK_ID> — sync the task's pm-output.yaml as the PM, at T0; prints nothing, returns the exit code.
sync_pm() { AI_OFFICE_NOW=$T0 ruby "$SYNC" "$1" pm "$RUNS/$1/status.yaml" "$RUNS/$1/pm-output.yaml" 2026-10-08 in_review >"$RUNS/sync.log" 2>&1; }
gates_dump() { ruby -ryaml -rdate -e 's = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time]); print YAML.dump(s["completion_gates"])' "$1"; }
history_phases() { ruby -ryaml -rdate -e 's = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time]); puts Array(s["history"]).map { |h| h["phase"] }' "$1"; }
# EAR-384 shape: the whole plan lands in one sync, with the normal PM transition.
D="$(task TASK-1600 pending)"
pm_output TASK-1600 "$EAR384_PLAN"
sync_pm TASK-1600 || fail "S first sync failed: $(cat "$RUNS/sync.log")"
assert_eq "$(field "$D/status.yaml" phase)" "assigned" "S the PM transition still happens"
assert_eq "$(field "$D/status.yaml" completion_gates.shared_lib_publication.actor)" "pm" "S declared by pm"
assert_eq "$(field "$D/status.yaml" completion_gates.shared_lib_publication.after)" "product_contract" "S after"
assert_eq "$(field "$D/status.yaml" completion_gates.shared_lib_publication.requires_record)" "true" "S requires_record"
assert_eq "$(field "$D/status.yaml" completion_gates.authenticated_staging.requires_authorization)" "deploy_staging" "S binding"
assert_eq "$(history_phases "$D/status.yaml" | tr '\n' '|')" \
  "gate product_contract: absent -> pending|gate shared_lib_publication: absent -> pending|gate implementation_verification: absent -> pending|gate authenticated_staging: absent -> pending|pending -> assigned|" "S history rows"
assert_eq "$(grep -c 'type: completion_gate_updated' "$D/meta.yaml")" "4" "S one meta event per declared gate"
validate "$D/status.yaml" || fail "S synced status invalid: $(cat "$RUNS/validate.log")"
grep -qxF "  implementation_verification: pending — waits on shared_lib_publication (pending)" <<<"$(bash "$RUN_AGENT" status TASK-1600)" || fail "S status does not show the planned wait"
# The same gates as the writer would make, command by command.
D2="$(task TASK-1601 pending)"
AI_OFFICE_NOW=$T0 gate TASK-1601 declare product_contract --actor pm --reason "contract locked with the operator" >/dev/null
AI_OFFICE_NOW=$T0 gate TASK-1601 declare shared_lib_publication --actor pm --reason "Game and gateway consume the published contract" --after product_contract --requires-record >/dev/null
AI_OFFICE_NOW=$T0 gate TASK-1601 declare implementation_verification --actor pm --reason "Game and gateway verified against the published contract" --after shared_lib_publication >/dev/null
AI_OFFICE_NOW=$T0 gate TASK-1601 declare authenticated_staging --actor pm --reason "authenticated smoke on staging" --after implementation_verification --requires-authorization deploy_staging >/dev/null
assert_eq "$(gates_dump "$D/status.yaml")" "$(gates_dump "$D2/status.yaml")" "S the sync builds exactly the writer's gate records"
# A repeat of the same output is a no-op; a re-plan with the same gates changes no gate.
cp "$D/status.yaml" "$RUNS/s-before.yaml"
sync_pm TASK-1600 || fail "S repeat sync failed"
cmp -s "$D/status.yaml" "$RUNS/s-before.yaml" || fail "S repeating the same output changed status.yaml"
printf 'summary: Re-planned without gate changes\n' > "$RUNS/s-summary.yaml"
ruby -ryaml -rdate -e 'p = ARGV[0]; s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time]); s["summary"] = "Re-planned"; File.write(p, YAML.dump(s))' "$D/pm-output.yaml"
before_gates="$(gates_dump "$D/status.yaml")"
sync_pm TASK-1600 || fail "S re-plan sync failed: $(cat "$RUNS/sync.log")"
assert_eq "$(gates_dump "$D/status.yaml")" "$before_gates" "S an unchanged plan changes no gate"
assert_eq "$(history_phases "$D/status.yaml" | grep -c '^gate ')" "4" "S an unchanged plan adds no gate history"
# A grown plan: a new gate, an added after, an added requires_record on a pending gate.
D="$(task TASK-1602 pending)"
pm_output TASK-1602 'completion_gates:
  - {name: a, reason: a}
  - {name: b, reason: b, after: [a]}'
sync_pm TASK-1602 || fail "S grow setup failed: $(cat "$RUNS/sync.log")"
pm_output TASK-1602 'completion_gates:
  - {name: a, reason: a}
  - {name: c, reason: c}
  - {name: b, reason: "b waits on c too", after: [a, c], requires_record: true}'
sync_pm TASK-1602 || fail "S grow sync failed: $(cat "$RUNS/sync.log")"
assert_eq "$(field "$D/status.yaml" completion_gates.b.after)" "a,c" "S after appended"
assert_eq "$(field "$D/status.yaml" completion_gates.b.requires_record)" "true" "S requires_record added"
assert_eq "$(history_phases "$D/status.yaml" | grep '^gate ' | tr '\n' '|')" \
  "gate a: absent -> pending|gate b: absent -> pending|gate c: absent -> pending|gate b: after += c|gate b: requires_record|" "S grow rows"
# A gate the plan does not list is kept.
pm_output TASK-1602 'completion_gates:
  - {name: a, reason: a}'
sync_pm TASK-1602 || fail "S partial plan sync failed: $(cat "$RUNS/sync.log")"
assert_eq "$(field "$D/status.yaml" completion_gates.c.status)" "pending" "S an unlisted gate is kept"
# Conflicts: exit 6, status.yaml and meta.yaml untouched.
D="$(task TASK-1603 pending)"
gate TASK-1603 declare a --actor pm --reason a >/dev/null
gate TASK-1603 declare b --actor pm --reason b --after a --requires-record >/dev/null
gate TASK-1603 declare p --actor pm --reason p >/dev/null
gate TASK-1603 pass p --actor reviewer --reason done >/dev/null
s_conflict() { # <label> <completion_gates YAML> <message fragment>
  pm_output TASK-1603 "$2"
  cp "$RUNS/TASK-1603/status.yaml" "$RUNS/c-status.before"; cp "$RUNS/TASK-1603/meta.yaml" "$RUNS/c-meta.before"
  rc=0; sync_pm TASK-1603 || rc=$?
  assert_eq "$rc" "6" "S conflict $1 exit ($(cat "$RUNS/sync.log"))"
  grep -qF "$3" "$RUNS/sync.log" || fail "S conflict $1 message: $(cat "$RUNS/sync.log")"
  cmp -s "$RUNS/TASK-1603/status.yaml" "$RUNS/c-status.before" || fail "S conflict $1 wrote status.yaml"
  cmp -s "$RUNS/TASK-1603/meta.yaml" "$RUNS/c-meta.before" || fail "S conflict $1 wrote meta.yaml"
}
s_conflict binding 'completion_gates:
  - {name: b, reason: x, after: [a], requires_record: true, requires_authorization: deploy_staging}' "gate b: the plan changes requires_authorization"
s_conflict after-dropped 'completion_gates:
  - {name: b, reason: x, requires_record: true}' "gate b: the plan drops after a"
s_conflict record-dropped 'completion_gates:
  - {name: b, reason: x, after: [a]}' "gate b: the plan drops requires_record"
s_conflict passed 'completion_gates:
  - {name: p, reason: x, requires_record: true}' "gate p: the plan adds to a gate that is pass"
s_conflict unknown-after 'completion_gates:
  - {name: e, reason: x, after: [zz]}' "completion_gates.e.after names zz, which is not a declared gate"
s_conflict cycle 'completion_gates:
  - {name: f, reason: x, after: [b]}
  - {name: a, reason: x, after: [f]}' "creates a cycle through"
# A malformed plan reaching the sync directly is malformed output (exit 3).
pm_output TASK-1603 'completion_gates: {}'
rc=0; sync_pm TASK-1603 || rc=$?
assert_eq "$rc" "3" "S malformed plan exit"
# Review Focus: an empty plan is valid and declares nothing.
D="$(task TASK-1610 pending)"
pm_output TASK-1610 'completion_gates: []'
validate "$D/pm-output.yaml" || fail "RF empty plan rejected: $(cat "$RUNS/validate.log")"
sync_pm TASK-1610 || fail "RF empty plan sync failed: $(cat "$RUNS/sync.log")"
assert_eq "$(field "$D/status.yaml" completion_gates)" "" "RF an empty plan declares nothing"
# Review Focus: `after` may name a gate listed later in the same plan.
D="$(task TASK-1611 pending)"
pm_output TASK-1611 'completion_gates:
  - {name: b, reason: b, after: [c]}
  - {name: c, reason: c}'
sync_pm TASK-1611 || fail "RF forward reference sync failed: $(cat "$RUNS/sync.log")"
assert_eq "$(field "$D/status.yaml" completion_gates.b.after)" "c" "RF forward reference"
# Review Focus: re-syncing an unchanged plan after a gate passed is not a conflict.
gate TASK-1611 pass c --actor dev --reason done >/dev/null
ruby -ryaml -rdate -e 'p = ARGV[0]; s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time]); s["summary"] = "after c passed"; File.write(p, YAML.dump(s))' "$D/pm-output.yaml"
sync_pm TASK-1611 || fail "RF re-sync after a pass failed: $(cat "$RUNS/sync.log")"
assert_eq "$(field "$D/status.yaml" completion_gates.c.status)" "pass" "RF the passed gate is untouched"
# Review Focus: a non-PM output carrying completion_gates is ignored.
D="$(task TASK-1612)"
cat > "$D/dev-output.yaml" <<'YAML'
summary: implemented
artifacts: []
blockers: []
next_action:
  agent: reviewer
  reason: ready for review
completion_gates:
  - {name: sneaky, reason: not the PM}
YAML
AI_OFFICE_NOW=$T0 ruby "$SYNC" TASK-1612 dev "$D/status.yaml" "$D/dev-output.yaml" 2026-10-08 in_review >"$RUNS/sync.log" 2>&1 || fail "RF dev sync failed: $(cat "$RUNS/sync.log")"
assert_eq "$(field "$D/status.yaml" completion_gates)" "" "RF a dev output cannot declare gates"
# Review Focus: after a refused plan, a corrected plan applies.
D="$(task TASK-1613 pending)"
gate TASK-1613 declare b --actor pm --reason b --requires-record >/dev/null
pm_output TASK-1613 'completion_gates:
  - {name: b, reason: x}'
rc=0; sync_pm TASK-1613 || rc=$?
assert_eq "$rc" "6" "RF setup: the first plan conflicts"
pm_output TASK-1613 'completion_gates:
  - {name: b, reason: x, requires_record: true}
  - {name: c, reason: c, after: [b]}'
sync_pm TASK-1613 || fail "RF the corrected plan did not apply: $(cat "$RUNS/sync.log")"
assert_eq "$(field "$D/status.yaml" completion_gates.c.after)" "b" "RF corrected plan applied"
````

Section D:

````bash
# --- D: run-agent.sh routes a conflicting gate plan (exit 6) to validation_failed ---
# A stub codex "runs" the PM by copying a prepared output into place, so the
# driver syncs it exactly as it would a real run.
STUB_BIN="$RUNS/stub-bin"; mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/codex" <<'SH'
#!/usr/bin/env bash
cp "$STUB_OUTPUT_SRC" "$STUB_OUTPUT_DST"
SH
chmod +x "$STUB_BIN/codex"
# dispatch_pm <TASK_ID> <prepared pm-output> — dispatch the PM through the stub; output in $RUNS/dispatch.log.
dispatch_pm() {
  STUB_OUTPUT_SRC="$2" STUB_OUTPUT_DST="$RUNS/$1/pm-output.yaml" PATH="$STUB_BIN:/usr/bin:/bin" \
    bash "$RUN_AGENT" "$1" pm codex >"$RUNS/dispatch.log" 2>&1
}
D="$(task TASK-1700 pending)"
gate TASK-1700 declare b --actor pm --reason b --requires-record >/dev/null
pm_output TASK-1799 'completion_gates:
  - {name: b, reason: x}'
ruby -ryaml -rdate -e 'p = ARGV[0]; s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time]); s["task"]["id"] = "TASK-1700"; File.write(p, YAML.dump(s))' "$RUNS/TASK-1799/pm-output.yaml"
cp "$RUNS/TASK-1799/pm-output.yaml" "$RUNS/d-plan.yaml"; rm -rf "$RUNS/TASK-1799"
dispatch_pm TASK-1700 "$RUNS/d-plan.yaml" || fail "D dispatch failed: $(tail -5 "$RUNS/dispatch.log")"
grep -q "gate b: the plan drops requires_record" "$RUNS/dispatch.log" || fail "D the conflict is not reported: $(cat "$RUNS/dispatch.log")"
assert_eq "$(field "$D/status.yaml" phase)" "validation_failed" "D a conflicting gate plan routes to validation_failed"
assert_eq "$(field "$D/status.yaml" completion_gates.b.requires_record)" "true" "D the stored gate is untouched"
grep -q "reason=gate_plan_conflict" "$D/meta.yaml" || fail "D validation_failed meta event"
````

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/pm-gate-plan.sh`
Expected: FAIL with `[FAIL] S declared by pm: expected 'pm', got ''`.

- [ ] **Step 3: Patch the sync**

Save as `2e-sync-patch.rb` in the scratchpad, then run `ruby <scratchpad>/2e-sync-patch.rb scripts/sync-status-from-output.rb`:

```ruby
# encoding: utf-8
path = ARGV[0]
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  s.sub!(old) { new } or abort "no match: #{old[0, 70].inspect}"
end
rep!(s, "# 4 corrupt status.yaml; 5 completion blocked by an unresolved completion gate (issue #28, status.yaml untouched); 9 ownership fence refused",
        "# 4 corrupt status.yaml; 5 completion blocked by an unresolved completion gate (issue #28, status.yaml untouched); 6 the PM gate plan conflicts with status.yaml (issue #28 Phase 2E, status.yaml untouched); 9 ownership fence refused")
rep!(s, "work_agents = [\"dev\", \"dev-2\", \"reviewer\", \"debugger\", \"devops\"]\n", <<'RUBY' + "work_agents = [\"dev\", \"dev-2\", \"reviewer\", \"debugger\", \"devops\"]\n")
# Issue #28 Phase 2E: a PM output may plan completion gates. Declare them here,
# add-only, in this same critical section and single write, with the gate
# writer's record and history construction. A plan that would change or remove
# a stored gate refuses the whole sync (exit 6) before anything is written.
gate_plan_events = []
if actor_agent == "pm" && output.is_a?(Hash) && output.key?("completion_gates")
  plan_problems = CompletionGuard.plan_gate_errors(output["completion_gates"])
  unless plan_problems.empty?
    warn "#{actor_agent} output completion_gates is malformed for #{task_id}: #{plan_problems.first}"
    exit 3
  end
  if status.key?("completion_gates") && !status["completion_gates"].is_a?(Hash)
    warn "Gate plan conflicts with status.yaml for #{task_id}: completion_gates is not a map"
    exit 6
  end
  gate_now = begin
    AuthorizationLedger.format_time(AuthorizationLedger.now_utc)
  rescue AuthorizationLedger::Error
    Time.now.utc.strftime("%FT%TZ")
  end
  planned_gates, gate_changes, gate_conflict = CompletionGuard.reconcile_gate_plan(
    status["completion_gates"] || {}, output["completion_gates"], actor: "pm", at: gate_now
  )
  if gate_conflict
    warn "Gate plan conflicts with status.yaml for #{task_id}: #{gate_conflict}"
    exit 6
  end
  unless gate_changes.empty?
    status["completion_gates"] = planned_gates
    status["history"] = [] unless status["history"].is_a?(Array)
    gate_changes.each { |row, _details| status["history"] << row }
    gate_plan_events = gate_changes.map { |_row, details| details }
  end
end

RUBY
rep!(s, "puts \"Status synced: \#{old_phase} -> \#{new_phase} (next: \#{next_agent})\"\n",
        "gate_plan_events.each do |details|\n" \
        "  CompletionGuard.append_meta_event!(File.dirname(status_path), type: \"completion_gate_updated\",\n" \
        "                                     agent: CompletionGuard.event_agent(\"pm\"), details: details)\n" \
        "end\n" \
        "puts \"Status synced: \#{old_phase} -> \#{new_phase} (next: \#{next_agent})\"\n")
File.write(path, s)
```

Run: `bash tests/integration/pm-gate-plan.sh`
Expected: FAIL now only at section D: `[FAIL] D a conflicting gate plan routes to validation_failed: expected 'validation_failed', got 'pending'`. The driver reports `Status sync aborted (rc=6)`.

- [ ] **Step 4: Patch the driver's exit-6 route**

Save as `2e-runagent-sync-patch.rb` in the scratchpad, then run `ruby <scratchpad>/2e-runagent-sync-patch.rb run-agent.sh`, and then `bash -n run-agent.sh`:

```ruby
# encoding: utf-8
path = ARGV[0]
s = File.read(path, encoding: "UTF-8")
old = <<'OLD'
      elif [[ "$SYNC_RC" -eq 5 ]]; then
OLD
new = <<'NEW'
      elif [[ "$SYNC_RC" -eq 6 ]]; then
        # Issue #28 Phase 2E: the PM's gate plan conflicts with status.yaml (it would
        # change or remove a stored gate). Nothing was written; route like malformed
        # output so the PM is re-run with the reason instead of skipping it silently.
        echo "PM gate plan conflicts with status.yaml; routing to validation_failed (not propagating)."
        force_status_route "$TASK_ID" "$STATUS_FILE" "$TODAY" "free-roam" "validation_failed" "$AGENT" "gate plan conflicts with status.yaml (see the sync message above)"
        record_run_update update "outcome.validation=failed"
        log_meta_event "$TASK_ID" "$META_FILE" "validation_failed" "$AGENT" "task=$TASK_LABEL reason=gate_plan_conflict output=runs/$TASK_ID/$(basename "$OUTPUT_FILE")"
      elif [[ "$SYNC_RC" -eq 5 ]]; then
NEW
abort "anchor count #{s.scan(old).size}" unless s.scan(old).size == 1
s.sub!(old) { new }
File.write(path, s)
```

- [ ] **Step 5: Run the suite**

Run: `bash tests/integration/pm-gate-plan.sh`
Expected: `[PASS] pm-gate-plan: …`

- [ ] **Step 6: Prove the sync and the route bite**

Each change below is made, the suite is run and the failure confirmed, and then the file is restored.

1. In the sync, change `gate_plan_events.each do |details|` to `[].each do |details|`. Expect `[FAIL] S one meta event per declared gate`.
2. In `run-agent.sh`, change `elif [[ "$SYNC_RC" -eq 6 ]]; then` to `elif [[ "$SYNC_RC" -eq 66 ]]; then`. Expect `[FAIL] D a conflicting gate plan routes to validation_failed`.

- [ ] **Step 7: Commit**

```bash
git add scripts/sync-status-from-output.rb run-agent.sh tests/integration/pm-gate-plan.sh
git commit -m "feat(office): syncing PM output declares its gate plan, add-only (#28 Phase 2E)

A conflicting plan refuses the sync (exit 6, nothing written) and run-agent.sh
routes it to validation_failed so the PM is re-run.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The shared gate text and the prompt block

**Files:**
- Create: `scripts/gate-status-text.rb`
- Modify: `run-agent.sh` (the `status` heredoc's 2D renderer → `GateStatusText`; prompt assembly)
- Modify: `tests/integration/pm-gate-plan.sh` (section P)

**Interfaces:**
- Consumes: `CompletionGuard.gate_view`.
- Produces:
  - `GateStatusText.lines(status, task_dir)`, `.suffix(gate, finished_phase = nil)` and `.part(status, task_dir)`. These are the 2D methods, moved byte for byte.
  - The script `ruby scripts/gate-status-text.rb <task_dir>`, which prints the lines (nothing without gates or revisions) or `Gates: unavailable`, and always exits 0.

- [ ] **Step 1: Write section P (failing)**

Insert before the PASS line. The second heredoc is the pre-2E golden, captured from unmodified main with paths normalized.

````bash
# --- P: the COMPLETION GATES block in the dispatched prompt ---
# The interactive cursor runner (absent from PATH) writes the assembled prompt to
# .cursor-prompt.md and stops, so a dispatch here only assembles and records.
dispatch_prompt() { # <TASK_ID> — dispatch dev through cursor; the prompt lands in runs/<TASK>/.cursor-prompt.md
  PATH="/usr/bin:/bin" bash "$RUN_AGENT" "$1" dev cursor >"$RUNS/prompt-dispatch.log" 2>&1 || fail "P dispatch failed: $(tail -5 "$RUNS/prompt-dispatch.log")"
}
# A task with gates: the block follows STATUS and carries the status-view lines.
D="$(task TASK-1800)"
for g in product_contract shared_lib_publication implementation_verification authenticated_staging; do gate TASK-1800 declare "$g" --actor pm --reason intake >/dev/null; done
gate TASK-1800 depend implementation_verification --after shared_lib_publication --actor pm --reason order >/dev/null
gate TASK-1800 depend authenticated_staging --after implementation_verification --actor pm --reason order >/dev/null
gate TASK-1800 pass product_contract --actor dev-2 --reason locked >/dev/null
gate TASK-1800 pass shared_lib_publication --actor dev-2 --reason merged --ran-by operator --ran-ref 05fae97f >/dev/null
dispatch_prompt TASK-1800
ruby -e 'p = File.read(ARGV[0], encoding: "UTF-8"); i = p.index("\n--- COMPLETION GATES ---\n", p.index("\n--- STATUS ---\n") || 0) or abort "no block"; i += 1; j = p.index("--- OUTPUT PERSISTENCE REQUIREMENT ---"); print p[i...j]' "$D/.cursor-prompt.md" > "$RUNS/p-block.txt" \
  || fail "P the prompt has no COMPLETION GATES block"
cat > "$RUNS/p-expected.txt" <<'TXT'
--- COMPLETION GATES ---
Gates: 2/4 resolved
  product_contract: pass
  shared_lib_publication: pass — ran: operator 05fae97f
  implementation_verification: pending — can pass now
  authenticated_staging: pending — waits on implementation_verification (pending)
Revisions: none

TXT
diff -u "$RUNS/p-expected.txt" "$RUNS/p-block.txt" || fail "P COMPLETION GATES block"
ruby -e 'p = File.read(ARGV[0], encoding: "UTF-8"); abort "order" unless p.index("\n--- STATUS ---\n") < p.index("\n--- COMPLETION GATES ---\n")' "$D/.cursor-prompt.md" || fail "P block must follow STATUS"
# A task without gates: everything after the role contract is byte-identical to the pre-2E prompt.
mkdir -p "$RUNS/TASK-1400"
printf 'task_id: TASK-1400\nphase: assigned\nstate: assigned\niteration: 1\ncurrent_agent: dev\nready: true\nblocked_on: []\nwaiting_for: []\nassignment:\n  primary: dev\n  parallel: false\nupdated_at: "2026-10-01"\nhistory: []\n' > "$RUNS/TASK-1400/status.yaml"
printf '# TASK-1400\n\nDocs-only probe task.\n' > "$RUNS/TASK-1400/task.md"
dispatch_prompt TASK-1400
ruby -e 'p = File.read(ARGV[0], encoding: "UTF-8"); i = p.index("--- AI CONTEXT INDEX ---") or abort "x"; print p[i..-1].gsub(ARGV[1], "<RUNS>").gsub(ARGV[2], "<OFFICE>")' "$RUNS/TASK-1400/.cursor-prompt.md" "$RUNS" "$ROOT" > "$RUNS/n-prompt.txt"
cat > "$RUNS/n-prompt-expected.txt" <<'TXT'
--- AI CONTEXT INDEX ---
provider: socraticode
status: skipped
freshness: unknown
confidence: low
fallback: repo_search
queries:
  - "dev TASK-1400"
note: "Context lookup skipped because this task is not code-impacting."

--- TASK ---
# TASK-1400

Docs-only probe task.
--- STATUS ---
task_id: TASK-1400
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
updated_at: "2026-10-01"
history: []

--- OUTPUT PERSISTENCE REQUIREMENT ---
Before you finish, write the complete, valid YAML output to this exact path:
<RUNS>/TASK-1400/dev-output.yaml
Overwrite the prior artifact for this role if one exists. Do not merely print the
YAML or verdict in your terminal response: the orchestrator reads the file above
for its handoff. After writing it, validate it with:
ruby "<OFFICE>/validate-yaml.rb" "<RUNS>/TASK-1400/dev-output.yaml"

Produce your output following the Output Contract in your role definition.
TXT
diff -u "$RUNS/n-prompt-expected.txt" "$RUNS/n-prompt.txt" || fail "P a task without gates changed its prompt"
# The renderer as a script: nothing for a gateless task, "Gates: unavailable" when the task cannot be rendered.
assert_eq "$(ruby "$ROOT/scripts/gate-status-text.rb" "$RUNS/TASK-1400")" "" "P no output for a task without gates"
mkdir -p "$RUNS/TASK-1801"; printf 'task_id: [\n' > "$RUNS/TASK-1801/status.yaml"
assert_eq "$(ruby "$ROOT/scripts/gate-status-text.rb" "$RUNS/TASK-1801")" "Gates: unavailable" "P an unrenderable task"
````

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/pm-gate-plan.sh`
Expected: FAIL with `[FAIL] P the prompt has no COMPLETION GATES block`.

- [ ] **Step 3: Create `scripts/gate-status-text.rb`**

```ruby
#!/usr/bin/env ruby
# frozen_string_literal: true

# Phase 2D/2E (issue #28): the plain-text gate view, rendered from the read-only
# CompletionGuard.gate_view. Shared by `run-agent.sh status` and the dispatched
# prompt's --- COMPLETION GATES --- block, so both show the same lines.
#
# As a script: ruby scripts/gate-status-text.rb <task_dir> prints the
# Gates/Revisions lines (nothing for a task without completion_gates or
# revisions), or "Gates: unavailable" when the task cannot be rendered. It never
# writes and always exits 0, so it can never fail a dispatch.

require "yaml"
require "date"
require_relative "completion-guard"

module GateStatusText
  module_function

  # The Gates/Revisions lines for one task.
  def lines(status, task_dir)
    return [] unless status.is_a?(Hash) && (status.key?("completion_gates") || status.key?("revisions"))

    view = CompletionGuard.gate_view(status, task_dir)
    lines = []
    if status.key?("completion_gates")
      if view["readable"]
        lines << "Gates: #{view['summary']['resolved']}/#{view['summary']['total']} resolved"
        view["gates"].each { |gate| lines << "  #{gate['name']}: #{gate['status']}#{suffix(gate, view['finished_phase'])}" }
      else
        lines << "Gates: unreadable (#{view['problem']}; run validate-yaml.rb)"
      end
    end
    revisions = view["revisions"]
    lines << if revisions["count"].zero? then "Revisions: none"
             elsif revisions["latest"] then "Revisions: #{revisions['count']}, latest #{revisions['latest'].values_at('id', 'kind').join(' ')} @#{revisions['latest']['at']}"
             else "Revisions: #{revisions['count']}"
             end
    lines
  end

  def suffix(gate, finished_phase = nil)
    case gate["status"]
    when "pass", "na"
      return " — NOT resolved: #{gate['unresolved_reason']}" unless gate["resolved"]
      return "" unless gate["ran"].is_a?(Hash)

      " — ran: #{gate['ran']['by']} #{gate['ran']['ref'] || gate['ran']['url']}"
    when "pending"
      if finished_phase
        " — task is #{finished_phase}"
      elsif gate["passable"]
        " — can pass now#{gate['requires_record'] ? ' (needs --ran-by and --ran-ref/--ran-url)' : ''}"
      elsif !gate["waits_on"].empty?
        " — waits on #{gate['waits_on'].join(', ')}"
      elsif gate["requires_authorization"]
        " — waits for a #{gate['requires_authorization']} grant#{gate['grant'] == 'unknown' ? ' (authorization ledger unreadable)' : ''}"
      else
        ""
      end
    else
      ""
    end
  end

  # The all-tasks part, e.g. "gates=pass:2,pending:2,ready:1"; nil without gates.
  def part(status, task_dir)
    return nil unless status.is_a?(Hash) && status.key?("completion_gates")

    view = CompletionGuard.gate_view(status, task_dir)
    return "gates=unreadable" unless view["readable"]

    counts = view["summary"]["by_status"].map { |state, count| "#{state}:#{count}" }
    "gates=#{(counts + ["ready:#{view['summary']['passable']}"]).join(',')}"
  end
end

if $PROGRAM_NAME == __FILE__
  task_dir = ARGV[0].to_s
  begin
    status = YAML.safe_load(File.read(File.join(task_dir, "status.yaml")), permitted_classes: [Date, Time], aliases: true)
    text = GateStatusText.lines(status, task_dir)
    puts text unless text.empty?
  rescue StandardError
    puts "Gates: unavailable"
  end
end
```

- [ ] **Step 4: Patch `run-agent.sh`**

Save as `2e-runagent-prompt-patch.rb` in the scratchpad, then run `ruby <scratchpad>/2e-runagent-prompt-patch.rb run-agent.sh`, then `bash -n run-agent.sh`. Confirm the added lines are ASCII: `git diff run-agent.sh | grep '^+' | LC_ALL=C grep -c '[^ -~	]'` must print `0`.

```ruby
# encoding: utf-8
path = ARGV[0]
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  s.sub!(old) { new } or abort "no match: #{old[0, 70].inspect}"
end
# 1. The status heredoc: the 2D renderer moves to scripts/gate-status-text.rb.
a = s.index("# Phase 2D: the Gates/Revisions lines for one task, rendered from the\n") or abort "renderer start"
b_anchor = "  \"gates=\#{(counts + [\"ready:\#{view['summary']['passable']}\"]).join(',')}\"\nend\n"
b = s.index(b_anchor, a) or abort "renderer end"
s = s[0...a] + "# Phase 2D/2E: the Gates/Revisions text lives in scripts/gate-status-text.rb,\n# shared with the dispatched prompt's COMPLETION GATES block.\nrequire File.join(office_dir, \"scripts\", \"gate-status-text\")\n" + s[(b + b_anchor.size)..-1]
rep!(s, "  gate_status_lines(status, File.join(runs_dir, task_filter)).each { |line| puts line }\n",
        "  GateStatusText.lines(status, File.join(runs_dir, task_filter)).each { |line| puts line }\n")
rep!(s, "  gates_part = gate_status_part(status, File.join(runs_dir, task_id))\n",
        "  gates_part = GateStatusText.part(status, File.join(runs_dir, task_id))\n")
# 2. The prompt: a COMPLETION GATES block after STATUS, only for tasks with gates or revisions.
rep!(s, <<'OLD', <<'NEW')
STATUS_SECTION=""
if [[ -f "$STATUS_FILE" ]]; then
  STATUS_SECTION="
--- STATUS ---
$(cat "$STATUS_FILE")"
fi
OLD
STATUS_SECTION=""
if [[ -f "$STATUS_FILE" ]]; then
  STATUS_SECTION="
--- STATUS ---
$(cat "$STATUS_FILE")"
fi

# Issue #28 Phase 2E: the gate view (the same lines `run-agent.sh status` prints),
# so the role sees which gates can pass now and what each waits on. Empty for a
# task without gates or revisions, which keeps its prompt unchanged; the renderer
# never fails (it prints "Gates: unavailable" instead).
GATES_SECTION=""
if [[ -f "$STATUS_FILE" ]]; then
  GATES_TEXT="$(ruby "$OFFICE_DIR/scripts/gate-status-text.rb" "$TASK_DIR" 2>/dev/null || echo "Gates: unavailable")"
  if [[ -n "$GATES_TEXT" ]]; then
    GATES_SECTION="
--- COMPLETION GATES ---
$GATES_TEXT"
  fi
fi
NEW
rep!(s, "${TASK_SECTION}${STATUS_SECTION}${PM_SECTION}${PREV_SECTION}\n",
        "${TASK_SECTION}${STATUS_SECTION}${GATES_SECTION}${PM_SECTION}${PREV_SECTION}\n")
File.write(path, s)
```

- [ ] **Step 5: Run the suite and the 2D suite**

Run: `bash tests/integration/pm-gate-plan.sh && bash tests/integration/gate-status.sh && bash tests/integration/context-provider.sh`
Expected: each prints its PASS line. `gate-status.sh` pins the `status` bytes after the move, and `context-provider.sh` pins prompt assembly.

- [ ] **Step 6: Prove the prompt block bites**

In `run-agent.sh`, change `${TASK_SECTION}${STATUS_SECTION}${GATES_SECTION}${PM_SECTION}` to `${TASK_SECTION}${STATUS_SECTION}${PM_SECTION}`, and expect `[FAIL] P the prompt has no COMPLETION GATES block`. Then restore the file.

- [ ] **Step 7: Commit**

```bash
git add scripts/gate-status-text.rb run-agent.sh tests/integration/pm-gate-plan.sh
git commit -m "feat(office): COMPLETION GATES block in the dispatched prompt (#28 Phase 2E)

The 2D gate text moves to scripts/gate-status-text.rb, shared by
run-agent.sh status (same bytes) and prompt assembly.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Role contracts, docs and the full regression

**Files:**
- Modify: `agents/pm.md`, `agents/dev.md`, `agents/dev-2.md`, `agents/devops.md`, `agents/reviewer.md`
- Modify: `docs/completion-gates.md`, `docs/task-transition-contract.md`
- Modify: `tests/integration/pm-gate-plan.sh` (section R)

**Interfaces:**
- Consumes: the CLI and sync behaviour from Tasks 1–4.
- Produces: the contract rules and the docs.

- [ ] **Step 1: Write section R (failing)**

Insert before the PASS line:

````bash
# --- R: every role contract carries the Completion gates rule ---
for role in pm dev dev-2 devops reviewer; do
  f="$ROOT/agents/$role.md"
  section="$(ruby -e 's = File.read(ARGV[0], encoding: "UTF-8"); i = s.index("### Completion gates") or exit 1; j = s.index("## Exit Criteria", i) or exit 1; print s[i...j]' "$f")" \
    || fail "R agents/$role.md has no Completion gates rule before Exit Criteria"
  grep -qF "scripts/update-completion-gate.rb" <<<"$section" || fail "R agents/$role.md does not name the gate writer"
  grep -qF "docs/completion-gates.md" <<<"$section" || fail "R agents/$role.md does not link the gate docs"
  grep -qiF "never hand-edit" <<<"$section" || fail "R agents/$role.md does not forbid hand edits"
done
grep -qF -- "--ran-by" "$ROOT/agents/dev.md" || fail "R dev.md does not show --ran-*"
grep -qF -- "--ran-by" "$ROOT/agents/dev-2.md" || fail "R dev-2.md does not show --ran-*"
grep -qF -- "--authorization authz-NNN" "$ROOT/agents/devops.md" || fail "R devops.md does not show --authorization"
grep -qF "COMPLETION GATES" "$ROOT/agents/reviewer.md" || fail "R reviewer.md does not point at the prompt block"
ruby -ryaml -e 's = File.read(ARGV[0], encoding: "UTF-8"); i = s.index("## Output Contract"); j = s.index("## SocratiCode"); y = s[i...j][/```yaml\n(.*?)```/m, 1] or abort "no yaml"; abort "no completion_gates in the contract example" unless y.include?("completion_gates:")' "$ROOT/agents/pm.md" \
  || fail "R pm.md Output Contract example lacks completion_gates"
````

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/pm-gate-plan.sh`
Expected: FAIL with `[FAIL] R agents/pm.md has no Completion gates rule before Exit Criteria`.

- [ ] **Step 3: Add the rules to the five contracts**

Save as `2e-contracts-patch.rb` in the scratchpad, then run `ruby <scratchpad>/2e-contracts-patch.rb` from the worktree root:

```ruby
# encoding: utf-8
# Inserts the role-specific "### Completion gates" rule directly before
# "## Exit Criteria" in each contract, and the completion_gates example into
# pm.md's Output Contract. Run from the repository root.
COMMON = "Completion gates are checkpoints the task must meet before it can be `done` (see [docs/completion-gates.md](../docs/completion-gates.md)). The `COMPLETION GATES` block in your prompt shows each gate and whether it can pass now. Change gates only through `scripts/update-completion-gate.rb`; never hand-edit `completion_gates` in `status.yaml`."
RULES = {
  "pm" => <<~MD,
    ### Completion gates

    #{COMMON}

    - Plan the gates in `completion_gates` (see the Output Contract) for checkpoints the task must meet before `done`: publication, merge, deploy, staging smoke, backfill, runtime acceptance.
    - Use `after` for a real ordering, `requires_authorization` for an action that needs operator approval (`deploy_staging`, `deploy_production`, `production_data_mutation`, `production_backfill`, `live_load`, `external_side_effect`), and `requires_record: true` where what ran (commit, run, PR) must be recorded.
    - The sync declares them for you, add-only. A plan that would change or remove a stored gate is refused and routed back to you as `validation_failed`; to retire a gate, it is marked `na` with a reason instead.
  MD
  "dev" => <<~MD,
    ### Completion gates

    #{COMMON}

    - When your work satisfies a gate that can pass now, pass it: `ruby scripts/update-completion-gate.rb <TASK_ID> pass <gate> --actor dev --reason "<what was done>"`, adding `--ran-by <who> --ran-ref <commit/run> --ran-url <https://...>` when the gate requires a record (or whenever you have one).
    - If a gate no longer applies, mark it `na` with a reason. Do not pass a gate that is still waiting on another gate.
  MD
  "dev-2" => <<~MD,
    ### Completion gates

    #{COMMON}

    - When your work satisfies a gate that can pass now, pass it: `ruby scripts/update-completion-gate.rb <TASK_ID> pass <gate> --actor dev-2 --reason "<what was done>"`, adding `--ran-by <who> --ran-ref <commit/run> --ran-url <https://...>` when the gate requires a record (or whenever you have one).
    - If a gate no longer applies, mark it `na` with a reason. Do not pass a gate that is still waiting on another gate.
  MD
  "devops" => <<~MD,
    ### Completion gates

    #{COMMON}

    - Pass deploy and backfill gates once the action ran: `ruby scripts/update-completion-gate.rb <TASK_ID> pass <gate> --actor devops --reason "<what ran>" --authorization authz-NNN --ran-by <who> --ran-url <run URL>`. A bound gate needs a valid grant recorded with `scripts/record-authorization.rb`.
  MD
  "reviewer" => <<~MD,
    ### Completion gates

    #{COMMON}

    - Read the `COMPLETION GATES` block before your verdict. Do not report the task complete while a gate is unresolved (the `done` guard refuses it anyway); name the open gates in `blockers`.
    - Pass verification gates you checked yourself: `ruby scripts/update-completion-gate.rb <TASK_ID> pass <gate> --actor reviewer --reason "<what you verified>"`.
  MD
}.freeze
RULES.each do |role, text|
  path = "agents/#{role}.md"
  s = File.read(path, encoding: "UTF-8")
  i = s.index("## Exit Criteria") or abort "no Exit Criteria in #{path}"
  s = s[0...i] + text + "\n" + s[i..-1]
  File.write(path, s)
end
pm = "agents/pm.md"
s = File.read(pm, encoding: "UTF-8")
old = "assignment:\n  primary: dev | dev-2\n  parallel: false | true\n  reason: <why this agent or parallel mode>\n"
new = old + <<~YAML

  completion_gates:            # optional: checkpoints required before done (synced add-only)
    - name: <gate_name>
      reason: <why the task needs it>
      after: [<gate it waits on>]                 # optional
      requires_authorization: <action>            # optional, e.g. deploy_production
      requires_record: true                       # optional
YAML
abort "pm.md assignment anchor" unless s.scan(old).size == 1
s.sub!(old) { new }
File.write(pm, s)
```

- [ ] **Step 4: Run the suite**

Run: `bash tests/integration/pm-gate-plan.sh`
Expected: `[PASS] pm-gate-plan: …`. Section P still passes, because the contracts never contain the dashed block marker.

- [ ] **Step 5: Add the docs**

Save the section below as `2e-doc-gates.md` in the scratchpad:

````markdown
## Planning gates (Phase 2E)

The PM plans a task's gates in `pm-output.yaml`, and syncing the PM output declares them. No one hand-edits `completion_gates`:

```yaml
completion_gates:
  - name: shared_lib_publication
    reason: "Game and gateway consume the published contract"
    after: [product_contract]                  # optional
    requires_authorization: deploy_production  # optional
    requires_record: true                      # optional
```

- The validator checks the plan's shape:
  - names follow the gate-name grammar, with no duplicates;
  - every gate has a non-empty `reason`;
  - `after` is non-empty, has no duplicates and does not name the gate itself;
  - an action is a known one, and `requires_record` is `true`;
  - the listed gates contain no cycle.
- `sync-status-from-output.rb` applies the plan when it syncs the PM output, in the same lock, fence and single write as the transition. It is **add-only**:
  - **new gate:** declared `pending` with actor `pm`. The record, the history row (`gate X: absent -> pending`) and the `completion_gate_updated` meta event are the same as `declare` writes.
  - **unchanged gate:** left as it is. A repeated sync changes nothing.
  - **pending gate gaining `after` names or `requires_record`:** they are added with the same rows `depend` and `require-record` write.
  - **conflict:** the whole sync is refused with **exit 6** and nothing is written. A conflict is any plan that would change `requires_authorization`, drop an `after` name or `requires_record`, add to a gate that is no longer `pending`, name an unknown gate in `after`, or create a cycle. `run-agent.sh` routes exit 6 to `validation_failed`, so the PM is re-run.
  - **gate missing from the plan:** kept. Retire a gate with `na` through the writer.
- Each role contract (`agents/pm.md`, `dev.md`, `dev-2.md`, `devops.md`, `reviewer.md`) carries a "Completion gates" rule.
- The dispatched prompt carries a `--- COMPLETION GATES ---` block with the same lines as `run-agent.sh status`. It is rendered by `scripts/gate-status-text.rb`. A task without gates or revisions gets no block.

Limits: roles may still not act on a gate; the writer and guards keep the rules. The PM decides which gates a task needs, and nothing infers them. Gates added mid-task do not require a 2A revision. Spec: [`superpowers/specs/2026-10-08-gate-aware-roles-phase-2e-design.md`](superpowers/specs/2026-10-08-gate-aware-roles-phase-2e-design.md).

````

Save as `2e-docs.rb` in the scratchpad, then run `ruby <scratchpad>/2e-docs.rb docs/completion-gates.md docs/task-transition-contract.md <scratchpad>/2e-doc-gates.md`:

```ruby
# encoding: utf-8
gates_doc, transition_doc, section = ARGV
s = File.read(gates_doc, encoding: "UTF-8")
s.sub!("## Compatibility\n") { File.read(section, encoding: "UTF-8") + "## Compatibility\n" } or abort "compat"
File.write(gates_doc, s)
t = File.read(transition_doc, encoding: "UTF-8")
old = "  unresolved. See [`docs/completion-gates.md`](completion-gates.md#gate-run-records-phase-2c).\n"
new = old + "  The PM plans gates in `pm-output.yaml` (`completion_gates`, Phase 2E); syncing\n  the PM output declares them add-only, and a conflicting plan is refused with\n  sync exit 6 (routed to `validation_failed`). See\n  [`docs/completion-gates.md`](completion-gates.md#planning-gates-phase-2e).\n"
t.sub!(old) { new } or abort "transition"
File.write(transition_doc, t)
```

- [ ] **Step 6: Full regression**

Run every integration suite, because 2E touches `run-agent.sh`, the sync and the role contracts that many suites exercise:

```bash
pass=0; fail=0; for t in tests/integration/*.sh; do n=$(basename "$t" .sh); if bash "$t" > "<scratchpad>/2e-all-$n.log" 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL $n"; fi; done; echo "pass=$pass fail=$fail"
```

Expected: 51 suites pass and 2 fail: `event-gateway` (M3) and `task-input-integrity` (T10). Both fail identically on unmodified main e5966448 (Decisions, 9). Any other failure is a regression: fix the code, never the test.

```bash
for t in TASK-VS-003 TASK-VS-004 TASK-VS-006 TASK-VS-008 TASK-VS-010; do ruby validate-yaml.rb "$t" >/dev/null && echo "ok $t" || echo "FAIL $t"; done
```

Expected: five `ok` lines.

- [ ] **Step 7: Commit**

```bash
git add agents/pm.md agents/dev.md agents/dev-2.md agents/devops.md agents/reviewer.md docs/completion-gates.md docs/task-transition-contract.md tests/integration/pm-gate-plan.sh
git commit -m "docs(office): gate-aware role contracts and planning docs (#28 Phase 2E)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Spec coverage

| Spec item | Where |
|---|---|
| Design 1: the PM field and its validation; schema and parity | T1 `plan_gate_errors`; T2; tests U, V |
| Design 2: add-only reconcile (declare, no-op, `after +=`, `requires_record`) and conflicts (exit 6, nothing written) | T1 `reconcile_gate_plan`; T3; tests U, S |
| Design 2: the same records, rows and meta as the writer | T1 helpers; test S ("the sync builds exactly the writer's gate records") |
| Design 2: `run-agent.sh` routes exit 6 to `validation_failed` | T3; test D |
| Design 3: role contracts | T5; test R |
| Design 4: the prompt block and the renderer moved (`status` bytes kept) | T4; test P, `gate-status.sh` |
| Rollout and rollback: a PM output without the field is unchanged; unlisted gates kept | tests V, S, RF |
| Docs | T5 |

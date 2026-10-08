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

echo "[PASS] plan-revisions: plan revision record (#28 Phase 2A)"

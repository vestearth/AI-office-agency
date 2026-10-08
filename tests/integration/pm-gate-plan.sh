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

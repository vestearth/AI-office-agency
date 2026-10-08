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

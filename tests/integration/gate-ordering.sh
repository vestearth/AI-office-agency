#!/usr/bin/env bash
set -euo pipefail

# Issue #28 Phase 2B — gate ordering.
#
# A completion gate may declare `after: [gates]`. It cannot be passed until
# those gates are resolved (the same definition the done guard uses); `na` is
# not ordered. Orderings are declared with `declare --after` or added to a
# pending gate with `depend`; add-only and acyclic.
# Sections: U shared helpers, R replay (EAR-384/385), X writer refusals,
# B bound dependencies, C carry-forward / malformed state / fence,
# V stored-state validation, S team sync and revert safety.

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

# --- U: shared ordering helpers ---
ruby - "$ROOT" <<'RUBY'
require File.join(ARGV[0], "scripts", "completion-guard")
def check(label, actual, expected)
  abort "[FAIL] U #{label}: expected #{expected.inspect}, got #{actual.inspect}" unless actual == expected
end
done = { "status" => "pass", "actor" => "x", "reason" => "r", "updated_at" => "2026-10-08T01:00:00Z" }
g = { "a" => done, "b" => { "status" => "pending", "after" => ["a"] }, "c" => { "status" => "pending", "after" => ["b"] } }
check "gate_after", CompletionGuard.gate_after(g["c"]), ["b"]
check "gate_after none", CompletionGuard.gate_after(g["a"]), []
check "gate_after non-map", CompletionGuard.gate_after(nil), []
check "reaches", CompletionGuard.gate_reaches?(g, "c", "a"), true
check "does not reach", CompletionGuard.gate_reaches?(g, "a", "c"), false
check "valid ordering", CompletionGuard.ordering_errors(g), []
check "no ordering", CompletionGuard.ordering_errors({ "a" => done }), []
check "self", CompletionGuard.ordering_errors({ "a" => { "after" => ["a"] } }), ["completion_gates.a.after names the gate itself"]
check "unknown", CompletionGuard.ordering_errors({ "a" => { "after" => ["zz"] } }), ["completion_gates.a.after names zz, which is not a declared gate"]
check "empty list", CompletionGuard.ordering_errors({ "a" => { "after" => [] } }), ["completion_gates.a.after must be a non-empty list of gate names"]
check "not a list", CompletionGuard.ordering_errors({ "a" => { "after" => "b" } }), ["completion_gates.a.after must be a non-empty list of gate names"]
check "bad name", CompletionGuard.ordering_errors({ "a" => { "after" => ["Bad"] } }), ["completion_gates.a.after must be a non-empty list of gate names"]
check "duplicate", CompletionGuard.ordering_errors({ "a" => {}, "b" => { "after" => ["a", "a"] } }), ["completion_gates.b.after lists a gate twice"]
check "2-cycle", CompletionGuard.ordering_errors({ "a" => { "after" => ["b"] }, "b" => { "after" => ["a"] } }),
      ["completion_gates.a.after creates a cycle through b"]
check "3-cycle", CompletionGuard.ordering_errors({ "a" => { "after" => ["b"] }, "b" => { "after" => ["c"] }, "c" => { "after" => ["a"] } }),
      ["completion_gates.a.after creates a cycle through b"]
check "unresolved", CompletionGuard.unresolved_dependencies(g, g["c"], nil), ["b"]
check "resolved", CompletionGuard.unresolved_dependencies(g, g["b"], nil), []
check "na counts as resolved", CompletionGuard.unresolved_dependencies({ "a" => done.merge("status" => "na") }, { "after" => ["a"] }, nil), []
check "pass without metadata is unresolved", CompletionGuard.unresolved_dependencies({ "a" => { "status" => "pass" } }, { "after" => ["a"] }, nil), ["a"]
check "gate_record with after",
      CompletionGuard.gate_record(status: "pending", actor: "pm", reason: "r", updated_at: "T", after: ["a"]).keys,
      %w[status actor reason updated_at evidence_refs after]
check "gate_record bound with after, key order",
      CompletionGuard.gate_record(status: "pass", actor: "rv", reason: "r", updated_at: "T", requires_authorization: "live_load",
                                  authorization_refs: ["authz-001"], authorization_through: "authz-001", after: ["a"]).keys,
      %w[status actor reason updated_at evidence_refs requires_authorization authorization_refs authorization_through after]
check "gate_record without after is unchanged",
      CompletionGuard.gate_record(status: "pending", actor: "pm", reason: "r", updated_at: "T").keys,
      %w[status actor reason updated_at evidence_refs]
RUBY

echo "[PASS] gate-ordering: gate ordering (#28 Phase 2B)"
